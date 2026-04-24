import { Logger } from '@nestjs/common';
import { OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';

/**
 * Manages lifecycle hooks for WebSocket gateways
 * Detects and executes NestJS lifecycle hooks at appropriate times
 */
export class LifecycleHooksManager {
  private readonly logger = new Logger(LifecycleHooksManager.name);

  /**
   * Generic hook detection
   */
  private hasHook<T>(gateway: unknown, methodName: keyof T): gateway is T {
    return (
      gateway !== null &&
      typeof gateway === 'object' &&
      methodName in gateway &&
      typeof (gateway as Record<string, unknown>)[methodName as string] === 'function'
    );
  }

  hasInitHook(gateway: unknown): gateway is OnGatewayInit {
    return this.hasHook<OnGatewayInit>(gateway, 'afterInit');
  }

  hasConnectionHook(gateway: unknown): gateway is OnGatewayConnection {
    return this.hasHook<OnGatewayConnection>(gateway, 'handleConnection');
  }

  hasDisconnectHook(gateway: unknown): gateway is OnGatewayDisconnect {
    return this.hasHook<OnGatewayDisconnect>(gateway, 'handleDisconnect');
  }

  /**
   * Calls the afterInit hook if the gateway implements it
   */
  async callInitHook(gateway: unknown, server: unknown): Promise<void> {
    if (!this.hasInitHook(gateway)) return;

    await this.executeHook(
      gateway,
      'afterInit',
      () => gateway.afterInit(server),
      true // rethrow errors
    );
  }

  /**
   * Calls the handleConnection hook if the gateway implements it
   */
  async callConnectionHook(gateway: unknown, client: unknown, ...args: unknown[]): Promise<void> {
    if (!this.hasConnectionHook(gateway)) return;

    await this.executeHook(
      gateway,
      'handleConnection',
      () => gateway.handleConnection(client, ...args),
      false // don't rethrow - connection errors shouldn't crash the server
    );
  }

  /**
   * Calls the handleDisconnect hook if the gateway implements it
   */
  async callDisconnectHook(gateway: unknown, client: unknown): Promise<void> {
    if (!this.hasDisconnectHook(gateway)) return;

    await this.executeHook(
      gateway,
      'handleDisconnect',
      () => gateway.handleDisconnect(client),
      false // don't rethrow - disconnect errors shouldn't crash the server
    );
  }

  /**
   * Generic hook execution with error handling
   */
  private async executeHook(
    gateway: unknown,
    hookName: string,
    hookFn: () => unknown,
    rethrow: boolean
  ): Promise<void> {
    const gatewayName =
      (gateway as { constructor?: { name?: string } })?.constructor?.name ?? 'UnknownGateway';

    try {
      this.logger.debug(`Calling ${hookName} hook for ${gatewayName}`);
      await hookFn();
      this.logger.debug(`${hookName} hook completed for ${gatewayName}`);
    } catch (error) {
      this.logger.error(`Error in ${hookName} hook for ${gatewayName}: ${this.formatError(error)}`);
      if (rethrow) throw error;
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
