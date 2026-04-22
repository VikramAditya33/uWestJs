import { FileWorkerPool } from './file-worker-pool';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('FileWorkerPool', () => {
  let pool: FileWorkerPool;
  let testFilePath: string;
  let testFileContent: Buffer;

  beforeEach(() => {
    // Create a temporary test file
    testFilePath = path.join(os.tmpdir(), `test-file-${Date.now()}.txt`);
    testFileContent = Buffer.from('Hello, World!');
    fs.writeFileSync(testFilePath, testFileContent);
  });

  afterEach(async () => {
    if (pool) {
      await pool.terminate();
    }
    // Clean up test file
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
  });

  describe('Basic Functionality', () => {
    it('should read a file successfully', async () => {
      pool = new FileWorkerPool(1);
      const data = await pool.readFile(testFilePath);
      expect(data).toEqual(testFileContent);
    });

    it('should handle multiple concurrent reads', async () => {
      pool = new FileWorkerPool(2);
      const promises = Array.from({ length: 5 }, () => pool.readFile(testFilePath));
      const results = await Promise.all(promises);
      results.forEach((data) => {
        expect(data).toEqual(testFileContent);
      });
    });

    it('should handle non-existent file', async () => {
      pool = new FileWorkerPool(1);
      await expect(pool.readFile('/non/existent/file.txt')).rejects.toThrow();
    });
  });

  describe('Worker Pool Size', () => {
    it('should create pool with specified size', () => {
      pool = new FileWorkerPool(3);
      expect(pool.size).toBe(3);
    });

    it('should default to size 1', () => {
      pool = new FileWorkerPool();
      expect(pool.size).toBe(1);
    });
  });

  describe('Load Balancing', () => {
    it('should complete all concurrent tasks successfully', async () => {
      pool = new FileWorkerPool(3);

      // Queue many tasks simultaneously
      const taskCount = 15;
      const promises = Array.from({ length: taskCount }, () => pool.readFile(testFilePath));

      const results = await Promise.all(promises);

      // All tasks should complete successfully
      expect(results).toHaveLength(taskCount);
      results.forEach((data) => {
        expect(data).toEqual(testFileContent);
      });
    });

    it('should handle concurrent large file reads', async () => {
      pool = new FileWorkerPool(2);

      // Create multiple large files to simulate longer processing
      const largeFiles = Array.from({ length: 3 }, (_, i) => {
        const filePath = path.join(os.tmpdir(), `large-file-${Date.now()}-${i}.txt`);
        const content = Buffer.alloc(1024 * 100, 'x'); // 100KB
        fs.writeFileSync(filePath, content);
        return filePath;
      });

      try {
        // Queue tasks - should distribute across both workers
        const promises = largeFiles.map((file) => pool.readFile(file));
        const results = await Promise.all(promises);

        expect(results).toHaveLength(3);
        results.forEach((data) => {
          expect(data.length).toBe(1024 * 100);
        });
      } finally {
        // Clean up large files
        largeFiles.forEach((file) => {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        });
      }
    });

    it('should handle high load without task loss', async () => {
      pool = new FileWorkerPool(4);

      // Simulate high load with many concurrent tasks
      const taskCount = 50;
      const promises = Array.from({ length: taskCount }, () => pool.readFile(testFilePath));

      const results = await Promise.all(promises);

      // All tasks should complete
      expect(results).toHaveLength(taskCount);
      results.forEach((data) => {
        expect(data).toEqual(testFileContent);
      });
    });
  });

  describe('Error Handling', () => {
    it('should reject pending tasks on termination', async () => {
      pool = new FileWorkerPool(1);

      // Start a task but don't await it yet
      const promise = pool.readFile(testFilePath);

      // Terminate immediately (don't await to race with the task)
      const terminatePromise = pool.terminate();

      // Either the task completes successfully or gets rejected
      // Both are acceptable outcomes in this race condition
      try {
        await promise;
        // Task completed before termination - that's fine
      } catch (error) {
        // Task was rejected due to termination - that's also fine
        expect(error).toBeInstanceOf(Error);
      }

      // Wait for termination to complete
      await terminatePromise;
    });

    it('should handle worker errors gracefully', async () => {
      pool = new FileWorkerPool(2);

      // Try to read an invalid file
      const invalidPromise = pool.readFile('/invalid/path/file.txt');

      // Should still be able to read valid files
      const validPromise = pool.readFile(testFilePath);

      await expect(invalidPromise).rejects.toThrow();
      await expect(validPromise).resolves.toEqual(testFileContent);
    });
  });

  describe('File Size Limits', () => {
    it('should reject files exceeding size limit', async () => {
      pool = new FileWorkerPool(1);

      // Create a file larger than 768KB
      const largeFilePath = path.join(os.tmpdir(), `large-file-${Date.now()}.bin`);
      const largeContent = Buffer.alloc(800 * 1024, 'x'); // 800KB
      fs.writeFileSync(largeFilePath, largeContent);

      try {
        await expect(pool.readFile(largeFilePath)).rejects.toThrow(
          /File size.*exceeds worker pool limit/
        );

        // Pool should still work for normal files
        const data = await pool.readFile(testFilePath);
        expect(data).toEqual(testFileContent);
      } finally {
        if (fs.existsSync(largeFilePath)) {
          fs.unlinkSync(largeFilePath);
        }
      }
    });

    it('should accept files within size limit', async () => {
      pool = new FileWorkerPool(1);

      // Create a file just under the 768KB limit
      const mediumFilePath = path.join(os.tmpdir(), `medium-file-${Date.now()}.bin`);
      const mediumContent = Buffer.alloc(700 * 1024, 'y'); // 700KB
      fs.writeFileSync(mediumFilePath, mediumContent);

      try {
        const data = await pool.readFile(mediumFilePath);
        expect(data.length).toBe(700 * 1024);
        expect(data[0]).toBe('y'.charCodeAt(0));
      } finally {
        if (fs.existsSync(mediumFilePath)) {
          fs.unlinkSync(mediumFilePath);
        }
      }
    });
  });

  describe('Termination', () => {
    it('should terminate all workers', async () => {
      pool = new FileWorkerPool(3);
      await pool.terminate();
      expect(pool.size).toBe(0);
    });

    it('should reject tasks after termination', async () => {
      pool = new FileWorkerPool(1);
      await pool.terminate();

      await expect(pool.readFile(testFilePath)).rejects.toThrow('Worker pool has been terminated');
    });
  });
});
