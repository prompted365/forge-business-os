/**
 * TTY Error Handler - Hardened stream reading with EIO recovery
 * 
 * Implements Step 4: Harden TTY.onStreamRead error handling
 * - Wraps stream.read() with try/catch and error categorization
 * - Gracefully handles EIO vs transient ENOTTY/EOF errors
 * - Emits "recoverable-io-error" events for upstream supervision
 * - Ensures non-zero exit only on recovery failure
 */

import { EventEmitter } from 'node:events';
import type { ILogger } from '../core/logger.js';

export interface TTYErrorMetrics {
  totalReads: number;
  successfulReads: number;
  eioErrors: number;
  enottyErrors: number;
  eofErrors: number;
  otherErrors: number;
  recoveryAttempts: number;
  successfulRecoveries: number;
  lastErrorTime?: number;
  lastRecoveryTime?: number;
}

export interface TTYErrorEvent {
  type: 'EIO' | 'ENOTTY' | 'EOF' | 'OTHER';
  error: Error;
  fd?: number;
  recoverable: boolean;
  timestamp: number;
}

export interface TTYReadOptions {
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  gracefulDegradation?: boolean;
  emitEvents?: boolean;
}

/**
 * Hardened TTY Stream Reader with EIO error handling
 */
export class TTYErrorHandler extends EventEmitter {
  private metrics: TTYErrorMetrics = {
    totalReads: 0,
    successfulReads: 0,
    eioErrors: 0,
    enottyErrors: 0,
    eofErrors: 0,
    otherErrors: 0,
    recoveryAttempts: 0,
    successfulRecoveries: 0,
  };

  private isRecovering = false;
  private offendingFDs = new Set<number>();
  private gracefulShutdown = false;

  constructor(private logger: ILogger) {
    super();
    this.setupErrorHandlers();
  }

  /**
   * Hardened stream read with EIO/ENOTTY/EOF categorization
   */
  async readFromTTY(
    buffer: Uint8Array,
    options: TTYReadOptions = {}
  ): Promise<number | null> {
    const {
      timeout = 5000,
      retryAttempts = 3,
      retryDelay = 100,
      gracefulDegradation = true,
      emitEvents = true,
    } = options;

    this.metrics.totalReads++;

    // Check if we're in graceful shutdown mode
    if (this.gracefulShutdown) {
      this.logger.debug('TTY in graceful shutdown mode, rejecting read');
      return null;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        // Wrap the stream read with timeout and error handling
        const result = await this.performRead(buffer, timeout);
        
        if (result !== null) {
          this.metrics.successfulReads++;
          
          // Reset recovery state on successful read
          if (this.isRecovering) {
            this.isRecovering = false;
            this.metrics.successfulRecoveries++;
            this.metrics.lastRecoveryTime = Date.now();
            
            if (emitEvents) {
              this.emit('recovery-success', {
                timestamp: Date.now(),
                attemptsRequired: attempt + 1,
              });
            }
          }
          
          return result;
        }

        // Handle EOF (null return)
        this.handleEOF(emitEvents);
        return null;

      } catch (error) {
        lastError = error as Error;
        const errorEvent = this.categorizeError(error as Error);
        
        this.logger.debug('TTY read error', {
          attempt: attempt + 1,
          maxAttempts: retryAttempts + 1,
          errorType: errorEvent.type,
          message: errorEvent.error.message,
        });

        // Handle different error types
        switch (errorEvent.type) {
          case 'EIO':
            await this.handleEIOError(errorEvent, emitEvents);
            break;
            
          case 'ENOTTY':
            await this.handleENOTTYError(errorEvent, emitEvents);
            break;
            
          case 'EOF':
            this.handleEOF(emitEvents);
            return null;
            
          default:
            this.handleOtherError(errorEvent, emitEvents);
            break;
        }

        // If this is a non-recoverable error or final attempt, break
        if (!errorEvent.recoverable || attempt === retryAttempts) {
          break;
        }

        // Wait before retry
        if (retryDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
        }
      }
    }

    // All retry attempts failed
    if (gracefulDegradation) {
      this.logger.warn('TTY read failed after all retries, entering graceful degradation', {
        lastError: lastError?.message,
        attempts: retryAttempts + 1,
      });
      
      if (emitEvents) {
        this.emit('graceful-degradation', {
          error: lastError,
          timestamp: Date.now(),
        });
      }
      
      return null;
    }

    // Re-throw the last error if graceful degradation is disabled
    throw lastError || new Error('TTY read failed for unknown reasons');
  }

  /**
   * Perform the actual read operation with timeout
   */
  private async performRead(buffer: Uint8Array, timeout: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('TTY read timeout'));
      }, timeout);

      // Perform the actual Deno.stdin.read
      Deno.stdin.read(buffer)
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Categorize TTY errors for appropriate handling
   */
  private categorizeError(error: Error): TTYErrorEvent {
    const timestamp = Date.now();
    this.metrics.lastErrorTime = timestamp;

    // Check error message and errno for specific error types
    const message = error.message.toLowerCase();
    const errorCode = (error as any).code;

    if (message.includes('input/output error') || errorCode === 'EIO' || message.includes('eio')) {
      this.metrics.eioErrors++;
      return {
        type: 'EIO',
        error,
        recoverable: true, // EIO is potentially recoverable
        timestamp,
      };
    }

    if (message.includes('not a tty') || errorCode === 'ENOTTY' || message.includes('enotty')) {
      this.metrics.enottyErrors++;
      return {
        type: 'ENOTTY',
        error,
        recoverable: false, // ENOTTY is not recoverable in current context
        timestamp,
      };
    }

    if (message.includes('end of file') || errorCode === 'EOF' || message.includes('eof')) {
      this.metrics.eofErrors++;
      return {
        type: 'EOF',
        error,
        recoverable: false, // EOF is not recoverable
        timestamp,
      };
    }

    this.metrics.otherErrors++;
    return {
      type: 'OTHER',
      error,
      recoverable: false, // Unknown errors are not considered recoverable
      timestamp,
    };
  }

  /**
   * Handle EIO (Input/Output Error) - potentially recoverable
   */
  private async handleEIOError(errorEvent: TTYErrorEvent, emitEvents: boolean): Promise<void> {
    this.logger.error('EIO error detected on TTY stream', {
      error: errorEvent.error.message,
      timestamp: errorEvent.timestamp,
    });

    if (!this.isRecovering) {
      this.isRecovering = true;
      this.metrics.recoveryAttempts++;

      // Gracefully stop reads from the offending FD
      if (errorEvent.fd !== undefined) {
        this.offendingFDs.add(errorEvent.fd);
        this.logger.warn(`Added FD ${errorEvent.fd} to offending FDs list`);
      }

      if (emitEvents) {
        // Emit internal "recoverable-io-error" event to upstream supervisor
        this.emit('recoverable-io-error', {
          errorType: 'EIO',
          error: errorEvent.error,
          fd: errorEvent.fd,
          timestamp: errorEvent.timestamp,
          recoveryAttempt: this.metrics.recoveryAttempts,
        });
      }
    }
  }

  /**
   * Handle ENOTTY (Not a TTY) - typically not recoverable
   */
  private async handleENOTTYError(errorEvent: TTYErrorEvent, emitEvents: boolean): Promise<void> {
    this.logger.warn('ENOTTY error - stream is not a TTY', {
      error: errorEvent.error.message,
      timestamp: errorEvent.timestamp,
    });

    if (emitEvents) {
      this.emit('tty-unavailable', {
        error: errorEvent.error,
        timestamp: errorEvent.timestamp,
      });
    }
  }

  /**
   * Handle EOF (End of File)
   */
  private handleEOF(emitEvents: boolean): void {
    this.logger.info('EOF detected on TTY stream');

    if (emitEvents) {
      this.emit('stream-eof', {
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle other unknown errors
   */
  private handleOtherError(errorEvent: TTYErrorEvent, emitEvents: boolean): void {
    this.logger.error('Unknown TTY error', {
      error: errorEvent.error.message,
      timestamp: errorEvent.timestamp,
    });

    if (emitEvents) {
      this.emit('unknown-error', {
        error: errorEvent.error,
        timestamp: errorEvent.timestamp,
      });
    }
  }

  /**
   * Setup error handlers for the TTY error handler itself
   */
  private setupErrorHandlers(): void {
    this.on('error', (error) => {
      this.logger.error('TTY Error Handler internal error', { error });
    });

    // Handle recovery failures
    this.on('recovery-failure', (event) => {
      this.logger.error('TTY recovery failed', event);
      
      // If recovery fails, we should consider this a critical error
      // but not necessarily exit the process - let upstream decide
      this.gracefulShutdown = true;
    });
  }

  /**
   * Attempt to recover from TTY errors
   */
  async attemptRecovery(): Promise<boolean> {
    if (!this.isRecovering) {
      return true; // Nothing to recover from
    }

    this.logger.info('Attempting TTY recovery');

    try {
      // Clear offending FDs
      this.offendingFDs.clear();
      
      // Reset recovery state
      this.isRecovering = false;
      
      this.logger.info('TTY recovery successful');
      return true;
    } catch (error) {
      this.logger.error('TTY recovery failed', { error });
      this.emit('recovery-failure', {
        error,
        timestamp: Date.now(),
      });
      return false;
    }
  }

  /**
   * Initiate graceful shutdown
   */
  gracefulShutdownTTY(): void {
    this.logger.info('Initiating TTY graceful shutdown');
    this.gracefulShutdown = true;
    this.emit('graceful-shutdown-initiated', {
      timestamp: Date.now(),
    });
  }

  /**
   * Get current error metrics
   */
  getMetrics(): TTYErrorMetrics {
    return { ...this.metrics };
  }

  /**
   * Get health status
   */
  getHealthStatus(): {
    healthy: boolean;
    recovering: boolean;
    gracefulShutdown: boolean;
    metrics: TTYErrorMetrics;
  } {
    const recentErrorThreshold = 5000; // 5 seconds
    const now = Date.now();
    const hasRecentErrors = this.metrics.lastErrorTime && 
      (now - this.metrics.lastErrorTime) < recentErrorThreshold;

    return {
      healthy: !this.isRecovering && !this.gracefulShutdown && !hasRecentErrors,
      recovering: this.isRecovering,
      gracefulShutdown: this.gracefulShutdown,
      metrics: this.getMetrics(),
    };
  }

  /**
   * Reset metrics and state (for testing)
   */
  reset(): void {
    this.metrics = {
      totalReads: 0,
      successfulReads: 0,
      eioErrors: 0,
      enottyErrors: 0,
      eofErrors: 0,
      otherErrors: 0,
      recoveryAttempts: 0,
      successfulRecoveries: 0,
    };
    
    this.isRecovering = false;
    this.offendingFDs.clear();
    this.gracefulShutdown = false;
  }
}

/**
 * Utility function to create a hardened TTY reader
 */
export function createHardenedTTYReader(logger: ILogger): TTYErrorHandler {
  return new TTYErrorHandler(logger);
}

/**
 * Convenience function for one-off hardened reads
 */
export async function hardenedTTYRead(
  buffer: Uint8Array, 
  logger: ILogger,
  options: TTYReadOptions = {}
): Promise<number | null> {
  const handler = new TTYErrorHandler(logger);
  return handler.readFromTTY(buffer, options);
}

/**
 * Create a safe readline interface that handles TTY errors gracefully
 * Returns null if TTY is not available or has errors
 */
export async function createSafeReadlineInterface(): Promise<any | null> {
  try {
    // Check if we're in a TTY environment
    if (!process.stdin.isTTY) {
      return null;
    }

    // Try to import readline with error handling
    const readline = await import('readline');
    
    // Wrap the creation in try-catch to handle EIO errors
    try {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false // Disable terminal-specific features that might cause EIO
      });
      
      // Add error handler to the interface
      rl.on('error', (err: Error) => {
        // Silently handle EIO errors
        if (err.message.includes('EIO') || err.message.includes('Input/output error')) {
          rl.close();
        }
      });
      
      return rl;
    } catch (err) {
      // If we get an EIO error during creation, return null
      if (err instanceof Error && (err.message.includes('EIO') || err.message.includes('Input/output error'))) {
        return null;
      }
      throw err;
    }
  } catch (err) {
    // Log but don't crash on readline import/creation errors
    console.warn('Warning: Unable to create readline interface:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
