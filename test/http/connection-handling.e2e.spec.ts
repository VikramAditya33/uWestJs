// @ts-nocheck - NestJS decorators in test files cause false positive TypeScript errors
import { NestFactory } from '@nestjs/core';
import { Controller, Get, Post, Body, Res, Module, INestApplication } from '@nestjs/common';
import { UwsPlatformAdapter } from '../../src/http/platform/uws-platform.adapter';
import { UwsResponse } from '../../src/http/core/response';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_TEMP_DIR = path.join(os.tmpdir(), 'uwestjs-connection-e2e');

// ============================================================================
// Controllers
// ============================================================================

@Controller('connection-test')
class ConnectionTestController {
  /**
   * Endpoint for abort-during-request tests.
   * Reads the full body and echoes it back.
   */
  @Post('echo-body')
  echoBody(@Body() body: unknown, @Res() res: UwsResponse) {
    res.status(200).json({ received: true, size: JSON.stringify(body).length });
  }

  /**
   * Endpoint for abort-during-response tests.
   * Streams a large file so the client can abort mid-stream.
   */
  @Get('large-file')
  async largeFile(@Res() res: UwsResponse) {
    const testFilePath = path.join(TEST_TEMP_DIR, 'large-file.bin');
    const fileStream = fs.createReadStream(testFilePath);
    const stat = fs.statSync(testFilePath);
    res.setHeader('x-is-streamed', 'true');
    await res.stream(fileStream, stat.size);
  }

  /**
   * Slow endpoint for timeout tests.
   */
  @Get('slow-response')
  async slowResponse(@Res() res: UwsResponse) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    res.status(200).json({ status: 'slow-ok' });
  }

  /**
   * Simple health check endpoint to verify server survived aborts.
   */
  @Get('health')
  health(@Res() res: UwsResponse) {
    res.status(200).json({ status: 'ok' });
  }
}

@Module({
  controllers: [ConnectionTestController],
})
class TestModule {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Connection Handling E2E', () => {
  let app: INestApplication;
  let baseUrl: string;
  const port = 13373;

  beforeAll(async () => {
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }

    // Create a 2MB test file for abort-during-response tests
    fs.writeFileSync(
      path.join(TEST_TEMP_DIR, 'large-file.bin'),
      Buffer.alloc(2 * 1024 * 1024, 'x')
    );

    const adapter = new UwsPlatformAdapter({
      port,
    });
    app = await NestFactory.create(TestModule, adapter);
    await app.init();

    await new Promise<void>((resolve, reject) => {
      adapter.listen(port, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    baseUrl = `http://localhost:${port}`;
  }, 10000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
    // Clean up temp file
    try {
      fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  function healthCheck(): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/connection-test/health`, { agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(raw);
          } catch {
            body = { raw };
          }
          resolve({ status: res.statusCode || 0, body });
        });
        res.on('error', reject);
      });
      req.setTimeout(5000, () => {
        req.destroy(new Error('Health check timed out'));
      });
      req.on('error', reject);
    });
  }

  // ==========================================================================
  // Connection abort during request
  // ==========================================================================

  describe('abort during request', () => {
    it('should handle client abort before request body completes', async () => {
      await new Promise<void>((resolve) => {
        const req = http.request(
          `${baseUrl}/connection-test/echo-body`,
          {
            method: 'POST',
            agent: false,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '1000000',
            },
          },
          (res) => {
            // We don't expect to get here since we abort early
            res.on('data', () => {});
            res.on('end', resolve);
            res.on('error', () => resolve());
          }
        );

        req.on('error', () => resolve());

        // Write a small amount of data then abort
        req.write('{"partial": "');
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 20);
      });

      // Give server time to process the abort
      await new Promise((r) => setTimeout(r, 200));

      // Server must still be alive
      const health = await healthCheck();
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });

    it('should keep server healthy after multiple request aborts', async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => {
          const req = http.request(
            `${baseUrl}/connection-test/echo-body`,
            {
              method: 'POST',
              agent: false,
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': '500000',
              },
            },
            (res) => {
              res.on('data', () => {});
              res.on('end', resolve);
              res.on('error', () => resolve());
            }
          );
          req.on('error', () => resolve());
          req.write('{"data": "');
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 10);
        });
      }

      await new Promise((r) => setTimeout(r, 300));

      const health = await healthCheck();
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });
  });

  // ==========================================================================
  // Connection abort during response
  // ==========================================================================

  describe('abort during response', () => {
    it('should handle client abort during response streaming', async () => {
      let receivedBeforeAbort = 0;

      await new Promise<void>((resolve) => {
        const req = http.get(`${baseUrl}/connection-test/large-file`, { agent: false }, (res) => {
          res.on('data', (chunk: Buffer) => {
            receivedBeforeAbort += chunk.length;
            if (receivedBeforeAbort >= 64 * 1024) {
              res.destroy();
              req.destroy();
              resolve();
            }
          });

          res.on('error', () => resolve());
          res.on('end', () => resolve());
        });

        req.on('error', () => resolve());
      });

      expect(receivedBeforeAbort).toBeGreaterThanOrEqual(64 * 1024);

      // Give server time to process the abort
      await new Promise((r) => setTimeout(r, 300));

      // Server must still be alive
      const health = await healthCheck();
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });

    it('should survive multiple response aborts', async () => {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((resolve) => {
          const req = http.get(`${baseUrl}/connection-test/large-file`, { agent: false }, (res) => {
            let received = 0;
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received >= 32 * 1024) {
                res.destroy();
                req.destroy();
                resolve();
              }
            });
            res.on('error', () => resolve());
            res.on('end', () => resolve());
          });
          req.on('error', () => resolve());
        });
      }

      await new Promise((r) => setTimeout(r, 300));

      const health = await healthCheck();
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });
  });

  // ==========================================================================
  // Connection cleanup
  // ==========================================================================

  describe('connection cleanup', () => {
    it('should survive abort during request followed by abort during response', async () => {
      // Abort during request
      await new Promise<void>((resolve) => {
        const req = http.request(
          `${baseUrl}/connection-test/echo-body`,
          {
            method: 'POST',
            agent: false,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': '100000',
            },
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', resolve);
            res.on('error', () => resolve());
          }
        );
        req.on('error', () => resolve());
        req.write('{"start":');
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 15);
      });

      // Abort during response
      await new Promise<void>((resolve) => {
        const req = http.get(`${baseUrl}/connection-test/large-file`, { agent: false }, (res) => {
          let received = 0;
          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received >= 48 * 1024) {
              res.destroy();
              req.destroy();
              resolve();
            }
          });
          res.on('error', () => resolve());
          res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
      });

      await new Promise((r) => setTimeout(r, 300));

      const health = await healthCheck();
      expect(health.status).toBe(200);
      expect(health.body).toEqual({ status: 'ok' });
    });
  });

  // ==========================================================================
  // Keep-alive connections
  // ==========================================================================

  describe('keep-alive connections', () => {
    it('should handle multiple requests on a keep-alive connection', async () => {
      const agent = new http.Agent({ keepAlive: true });

      try {
        for (let i = 0; i < 5; i++) {
          const result = await new Promise<{ status: number; body: Record<string, unknown> }>(
            (resolve, reject) => {
              const req = http.get(`${baseUrl}/connection-test/health`, { agent }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                  const raw = Buffer.concat(chunks).toString();
                  let body: Record<string, unknown>;
                  try {
                    body = JSON.parse(raw);
                  } catch {
                    body = { raw };
                  }
                  resolve({ status: res.statusCode || 0, body });
                });
                res.on('error', reject);
              });
              req.setTimeout(5000, () => {
                req.destroy(new Error('Request timed out'));
              });
              req.on('error', reject);
            }
          );

          expect(result.status).toBe(200);
          expect(result.body).toEqual({ status: 'ok' });
        }
      } finally {
        agent.destroy();
      }
    });

    it('should handle keep-alive after an aborted request', async () => {
      const agent = new http.Agent({ keepAlive: true });

      try {
        // Abort a request on the keep-alive connection
        await new Promise<void>((resolve) => {
          const req = http.get(`${baseUrl}/connection-test/large-file`, { agent }, (res) => {
            let received = 0;
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              if (received >= 32 * 1024) {
                res.destroy();
                req.destroy();
                resolve();
              }
            });
            res.on('error', () => resolve());
            res.on('end', () => resolve());
          });
          req.on('error', () => resolve());
        });

        await new Promise((r) => setTimeout(r, 300));

        // Subsequent request on same agent should still work
        const health = await new Promise<{ status: number; body: Record<string, unknown> }>(
          (resolve, reject) => {
            const req = http.get(`${baseUrl}/connection-test/health`, { agent }, (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let body: Record<string, unknown>;
                try {
                  body = JSON.parse(raw);
                } catch {
                  body = { raw };
                }
                resolve({ status: res.statusCode || 0, body });
              });
              res.on('error', reject);
            });
            req.setTimeout(5000, () => {
              req.destroy(new Error('Request timed out'));
            });
            req.on('error', reject);
          }
        );

        expect(health.status).toBe(200);
        expect(health.body).toEqual({ status: 'ok' });
      } finally {
        agent.destroy();
      }
    });
  });

  // ==========================================================================
  // Timeout handling
  // ==========================================================================

  describe('timeout handling', () => {
    it('should complete slow responses without timing out', async () => {
      const result = await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = http.get(
            `${baseUrl}/connection-test/slow-response`,
            { agent: false },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(chunk));
              res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let body: Record<string, unknown>;
                try {
                  body = JSON.parse(raw);
                } catch {
                  body = { raw };
                }
                resolve({ status: res.statusCode || 0, body });
              });
              res.on('error', reject);
            }
          );
          req.setTimeout(10000, () => {
            req.destroy(new Error('Request timed out'));
          });
          req.on('error', reject);
        }
      );

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ status: 'slow-ok' });
    }, 15000);
  });
});
