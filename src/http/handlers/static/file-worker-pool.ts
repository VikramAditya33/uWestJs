/**
 * Worker pool for reading files in parallel without blocking the main thread
 *
 * Designed for small static files (< 768KB). Files exceeding this limit will be rejected
 * with an error. For larger files, use streaming via the static-file-handler instead.
 *
 * Workers are unref'd to allow the process to exit gracefully. This means:
 * - The worker pool won't prevent process shutdown
 * - Pending file read promises may never resolve if the process exits
 * - Call terminate() explicitly if you need to ensure clean shutdown
 */

import { Worker } from 'worker_threads';
import * as os from 'os';

interface WorkerTask {
  resolve: (data: ArrayBuffer) => void;
  reject: (error: Error) => void;
}

// Inline worker code as a string to avoid file path issues
const workerCode = `
const { parentPort } = require('worker_threads');
const fs = require('fs');

if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

// Maximum file size for worker pool (768KB)
// Files larger than this should use streaming via static-file-handler
const MAX_FILE_SIZE = 768 * 1024;

parentPort.on('message', (message) => {
  if (message.type === 'readFile') {
    try {
      // Check file size before reading to prevent blocking on large files
      const stats = fs.statSync(message.path);
      
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          \`File size (\${stats.size} bytes) exceeds worker pool limit (\${MAX_FILE_SIZE} bytes). \` +
          'Use streaming for large files.'
        );
      }
      
      const data = fs.readFileSync(message.path);
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      parentPort.postMessage({ key: message.key, data: ab }, [ab]);
    } catch (err) {
      parentPort.postMessage({ key: message.key, err: String(err) });
    }
  }
});
`;

class FileWorker {
  private worker: Worker;
  private pendingTaskKeys = new Set<number>();
  private isDead = false;

  constructor(
    private workerTasks: Map<number, WorkerTask>,
    private onDeath: (worker: FileWorker) => void
  ) {
    // Create worker from inline code
    this.worker = new Worker(workerCode, { eval: true });

    this.worker.on('message', (message: { key: number; data?: ArrayBuffer; err?: string }) => {
      this.pendingTaskKeys.delete(message.key);

      const task = this.workerTasks.get(message.key);

      if (!task) return;

      this.workerTasks.delete(message.key);

      if (message.err) {
        task.reject(new Error(message.err));
      } else if (message.data !== undefined) {
        task.resolve(message.data);
      } else {
        task.reject(new Error('Worker returned invalid response: missing data'));
      }
    });

    this.worker.on('error', (err: Error) => {
      if (this.isDead) return; // Already processed

      this.markAsDead();

      // Reject all pending tasks for this specific worker
      this.rejectAllPendingTasks(
        new Error(`Worker thread error: ${err.message}`, {
          cause: err,
        })
      );

      // Notify pool that this worker is dead
      this.onDeath(this);
    });

    this.worker.on('exit', (code: number) => {
      if (this.isDead) return; // Already processed via error handler or terminate()

      if (code !== 0) {
        this.markAsDead();

        // Reject all pending tasks if worker exited unexpectedly
        this.rejectAllPendingTasks(
          new Error(`Worker thread exited unexpectedly with code ${code}`)
        );

        // Notify pool that this worker is dead
        this.onDeath(this);
      } else {
        // Worker exited cleanly but unexpectedly - still mark as dead
        // Reject pending tasks since they'll never complete
        this.rejectAllPendingTasks(new Error('Worker thread exited unexpectedly'));

        this.markAsDead();
        this.onDeath(this);
      }
    });

    // Allow the process to exit even if this worker has pending tasks
    // This prevents the worker pool from keeping the process alive unnecessarily
    // Note: If the process exits with pending tasks, those promises will never resolve
    this.worker.unref();
  }

  private markAsDead(): void {
    this.isDead = true;
  }

  readFile(key: number, filePath: string): void {
    // Guard against posting to a dead worker
    if (this.isDead) {
      const task = this.workerTasks.get(key);
      if (task) {
        task.reject(new Error('Cannot read file: worker thread has terminated'));
        this.workerTasks.delete(key);
      }
      return;
    }

    this.pendingTaskKeys.add(key);
    this.worker.postMessage({ key, type: 'readFile', path: filePath });
  }

  /**
   * Reject all pending tasks with the given error
   */
  private rejectAllPendingTasks(error: Error): void {
    for (const key of this.pendingTaskKeys) {
      const task = this.workerTasks.get(key);
      if (task) {
        task.reject(error);
        this.workerTasks.delete(key);
      }
    }
    this.pendingTaskKeys.clear();
  }

  /**
   * Check if worker is idle (no pending tasks)
   */
  get isIdle(): boolean {
    return this.pendingTaskKeys.size === 0;
  }

  /**
   * Get the number of pending tasks for this worker
   */
  get pendingCount(): number {
    return this.pendingTaskKeys.size;
  }

  /**
   * Check if worker is dead
   */
  get dead(): boolean {
    return this.isDead;
  }

  terminate(): Promise<number> {
    this.markAsDead();
    return this.worker.terminate();
  }
}

/**
 * Pool of worker threads for reading files
 */
export class FileWorkerPool {
  private workers: FileWorker[] = [];
  private workerTasks = new Map<number, WorkerTask>();
  private taskKey = 0;
  private terminated = false;
  private readonly poolSize: number;

  constructor(size?: number) {
    // Default to CPU-aware pool size for better concurrency
    // Use at least 1, at most 4, and leave 1 CPU for the main thread
    const defaultSize = Math.max(1, Math.min(4, os.cpus().length - 1));
    this.poolSize = size ?? defaultSize;
    for (let i = 0; i < this.poolSize; i++) {
      this.workers.push(this.createWorker());
    }
  }

  /**
   * Create a new worker with death handler
   */
  private createWorker(): FileWorker {
    return new FileWorker(this.workerTasks, (deadWorker) => {
      this.handleWorkerDeath(deadWorker);
    });
  }

  /**
   * Handle worker death by replacing it with a new worker
   */
  private handleWorkerDeath(deadWorker: FileWorker): void {
    if (this.terminated) {
      // Don't replace workers if pool is terminated
      return;
    }

    // Find and replace the dead worker
    const index = this.workers.indexOf(deadWorker);
    if (index !== -1) {
      // Replace with a new worker to maintain pool size
      this.workers[index] = this.createWorker();
    }
  }

  /**
   * Read a file using a worker thread
   *
   * Files must be smaller than 768KB. Larger files will be rejected with an error.
   * For large files, use streaming via the static-file-handler instead.
   *
   * @param filePath - Path to the file to read
   * @returns Promise that resolves with the file data as Buffer
   * @throws Error if file exceeds size limit or worker pool is terminated
   */
  readFile(filePath: string): Promise<Buffer> {
    if (this.terminated) {
      return Promise.reject(new Error('Worker pool has been terminated'));
    }

    return new Promise((resolve, reject) => {
      // Select least busy worker (prefer idle workers, skip dead workers)
      const worker = this.selectWorker();

      if (!worker) {
        reject(new Error('No healthy workers available'));
        return;
      }

      // Create task with unique key
      const key = this.taskKey++;

      this.workerTasks.set(key, {
        resolve: (data: ArrayBuffer) => resolve(Buffer.from(data)),
        reject,
      });

      // Send work to worker
      worker.readFile(key, filePath);
    });
  }

  /**
   * Select the best worker for the next task
   * Prefers idle workers, falls back to least loaded worker
   * Skips dead workers
   */
  private selectWorker(): FileWorker | null {
    // Check if pool is empty (terminated or no workers)
    if (this.workers.length === 0) {
      return null;
    }

    // Filter out dead workers
    const aliveWorkers = this.workers.filter((w) => !w.dead);

    if (aliveWorkers.length === 0) {
      return null;
    }

    // Try to find an idle worker (no pending tasks)
    const idleWorker = aliveWorkers.find((w) => w.isIdle);
    if (idleWorker) return idleWorker;

    // All workers have pending tasks, select the one with fewest pending
    return aliveWorkers.reduce((least, current) =>
      current.pendingCount < least.pendingCount ? current : least
    );
  }

  /**
   * Get the number of workers in the pool (including dead ones being replaced)
   */
  get size(): number {
    return this.workers.length;
  }

  /**
   * Terminate all workers
   */
  async terminate(): Promise<void> {
    this.terminated = true;

    // Reject all pending tasks before terminating workers
    const terminationError = new Error('Worker pool terminated');
    for (const task of this.workerTasks.values()) {
      task.reject(terminationError);
    }
    this.workerTasks.clear();

    // Use allSettled to ensure cleanup always runs even if some workers fail to terminate
    await Promise.allSettled(this.workers.map((w) => w.terminate()));
    this.workers = [];
  }
}
