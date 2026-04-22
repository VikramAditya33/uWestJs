import busboy from 'busboy';
import type { Readable } from 'stream';
import type { UwsRequest } from './uws-request';

/**
 * Multipart field information
 */
export interface MultipartField {
  /**
   * Field name
   */
  name: string;

  /**
   * Field encoding
   */
  encoding: string;

  /**
   * MIME type
   */
  mimeType: string;

  /**
   * Field value (for non-file fields)
   */
  value?: string;

  /**
   * Truncation information (for non-file fields)
   */
  truncated?: {
    /**
     * Whether the field name was truncated
     */
    name: boolean;

    /**
     * Whether the field value was truncated
     */
    value: boolean;
  };

  /**
   * File information (for file fields)
   */
  file?: {
    /**
     * Original filename
     */
    filename: string;

    /**
     * Readable stream of file data
     */
    stream: Readable;
  };
}

/**
 * Multipart limit rejection reasons
 */
export type MultipartLimitReject =
  | 'PARTS_LIMIT_REACHED'
  | 'FILES_LIMIT_REACHED'
  | 'FIELDS_LIMIT_REACHED';

/**
 * Handler for processing multipart fields
 */
export type MultipartHandler = (field: MultipartField) => void | Promise<void>;

/**
 * Multipart form-data parser
 *
 * Handles parsing of multipart/form-data requests using busboy.
 * Supports both regular fields and file uploads with streaming.
 *
 * @example
 * ```typescript
 * const handler = new MultipartFormHandler(request);
 * await handler.parse(async (field) => {
 *   if (field.file) {
 *     // Handle file upload
 *     await saveFile(field.file.stream, field.file.filename);
 *   } else {
 *     // Handle regular field
 *     console.log(field.name, field.value);
 *   }
 * });
 * ```
 */
export class MultipartFormHandler {
  private multipartPromise: Promise<void> | null = null;
  private parsing = false;

  constructor(
    private readonly request: UwsRequest,
    private readonly options: busboy.BusboyConfig = {}
  ) {}

  /**
   * Parse multipart form data
   *
   * @param handler - Function to handle each field/file
   * @returns Promise that resolves when all fields are processed
   * @throws {MultipartLimitReject} When busboy limits are exceeded
   * @throws {Error} When parsing fails
   */
  async parse(handler: MultipartHandler): Promise<void> {
    // Guard against multiple parse() calls
    if (this.parsing) {
      throw new Error('parse() has already been called');
    }
    this.parsing = true;

    // Check if request has already ended
    if (this.request.readableEnded) {
      return;
    }

    // Check if content-type is multipart
    // Aligned with UwsRequest.multipart() - let busboy handle boundary validation
    const contentType = this.request.contentType;
    if (!contentType || !contentType.toLowerCase().startsWith('multipart/')) {
      return;
    }

    return new Promise((resolve, reject) => {
      // Create busboy instance with request headers
      // Busboy throws synchronously if boundary is missing - wrap it in try-catch
      let uploader: busboy.Busboy;
      try {
        uploader = busboy({
          headers: this.request.headers,
          ...this.options,
        });
      } catch (err) {
        reject(new Error(`Invalid multipart Content-Type: ${(err as Error).message}`));
        return;
      }

      let finished = false;
      const finish = async (error?: Error | MultipartLimitReject) => {
        if (finished) return;
        finished = true;

        // Silence "Unexpected end of form" error (client disconnect)
        const silentError = error instanceof Error && error.message === 'Unexpected end of form';

        if (error && !silentError) {
          reject(error);
        } else {
          // Wait for any pending handler execution
          // Wrap in try-catch to prevent unhandled rejections
          if (this.multipartPromise) {
            try {
              await this.multipartPromise;
            } catch {
              // Handler error already propagated via .catch(finish)
              // If we're here, it means finish was called twice (once from .catch, once from event)
              // Just ignore to avoid double rejection
            }
          }
          resolve();
        }

        // Destroy uploader - ignore any errors during cleanup
        try {
          uploader.destroy();
        } catch {
          // Ignore destroy errors after finish
        }
      };

      // Handle errors
      uploader.once('error', (err: Error) => void finish(err));

      // Handle all limit events with the same pattern
      const limitEvents: Array<[string, MultipartLimitReject]> = [
        ['partsLimit', 'PARTS_LIMIT_REACHED'],
        ['filesLimit', 'FILES_LIMIT_REACHED'],
        ['fieldsLimit', 'FIELDS_LIMIT_REACHED'],
      ];
      limitEvents.forEach(([event, reason]) => {
        uploader.once(event, () => void finish(reason));
      });

      // Handle regular fields
      uploader.on('field', (name: string, value: string, info: busboy.FieldInfo) => {
        this.handleField(handler, name, value, info).catch((err) => void finish(err));
      });

      // Handle file fields
      uploader.on('file', (name: string, stream: Readable, info: busboy.FileInfo) => {
        stream.once('error', (err) => void finish(err));
        this.handleFile(handler, name, stream, info).catch((err) => void finish(err));
      });

      // Handle completion
      uploader.once('close', () => {
        if (this.multipartPromise) {
          this.multipartPromise.then(() => void finish()).catch((err) => void finish(err));
        } else {
          void finish();
        }
      });

      // Pipe request to busboy
      this.request.pipe(uploader);
    });
  }

  /**
   * Handle a regular field
   */
  private async handleField(
    handler: MultipartHandler,
    name: string,
    value: string,
    info: busboy.FieldInfo
  ): Promise<void> {
    await this.executeHandler(handler, {
      name,
      encoding: info.encoding,
      mimeType: info.mimeType,
      value,
      truncated: {
        name: info.nameTruncated,
        value: info.valueTruncated,
      },
    });
  }

  /**
   * Handle a file field
   */
  private async handleFile(
    handler: MultipartHandler,
    name: string,
    stream: Readable,
    info: busboy.FileInfo
  ): Promise<void> {
    try {
      await this.executeHandler(handler, {
        name,
        encoding: info.encoding,
        mimeType: info.mimeType,
        file: {
          filename: info.filename,
          stream,
        },
      });
    } finally {
      // Always flush stream to prevent busboy from hanging
      // This is critical: if the handler throws, the stream must still be consumed
      if (!stream.readableEnded) {
        stream.resume();
      }
    }
  }

  /**
   * Execute handler with proper async handling and backpressure
   */
  private async executeHandler(handler: MultipartHandler, field: MultipartField): Promise<void> {
    // Wait for previous handler if still executing
    if (this.multipartPromise) {
      this.request.pause();
      await this.multipartPromise;
      this.request.resume();
    }

    // Execute handler
    const result = handler(field);
    if (result instanceof Promise) {
      this.multipartPromise = result;
      await this.multipartPromise;
      this.multipartPromise = null;
    }
  }
}
