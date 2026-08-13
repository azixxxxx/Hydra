import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';

import { HYDRA_VERSION } from './contract.js';

const OPTIONAL_ARGUMENT_TOOLS = new Set(['hydra_preflight', 'hydra_status']);

interface CallRequestShape {
  readonly id?: RequestId;
  readonly method?: unknown;
  readonly params?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
  };
}

interface CallResponseShape {
  readonly id?: RequestId;
  readonly result?: {
    readonly isError?: unknown;
    readonly structuredContent?: unknown;
    readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
  };
}

function normalizeIncoming<T extends JSONRPCMessage>(message: T): T {
  const request = message as CallRequestShape;
  if (
    request.method !== 'tools/call' ||
    request.params === undefined ||
    typeof request.params.name !== 'string' ||
    !OPTIONAL_ARGUMENT_TOOLS.has(request.params.name) ||
    Object.hasOwn(request.params, 'arguments')
  ) {
    return message;
  }
  return {
    ...message,
    params: { ...request.params, arguments: {} },
  };
}

function normalizedFailure(message: JSONRPCMessage): JSONRPCMessage {
  const response = message as CallResponseShape;
  if (
    response.result?.isError !== true ||
    response.result.structuredContent !== undefined
  ) {
    return message;
  }
  const rawText = response.result.content?.find(({ type }) => type === 'text')?.text;
  const inputInvalid =
    typeof rawText === 'string' && rawText.startsWith('Input validation error:');
  const structuredContent = {
    schemaVersion: 1 as const,
    hydraVersion: HYDRA_VERSION,
    response: {
      ok: false as const,
      error: {
        code: inputInvalid ? 'TOOL_INPUT_INVALID' : 'HYDRA_TOOL_REQUEST_FAILED',
        message: inputInvalid ? 'Hydra tool input validation failed' : 'Hydra tool request failed',
      },
    },
  };
  return {
    ...message,
    result: {
      ...response.result,
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    },
  };
}

export class HydraTransport implements Transport {
  readonly #delegate: Transport;
  public readonly sessionId?: string;

  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  public constructor(delegate: Transport) {
    this.#delegate = delegate;
    if (delegate.sessionId !== undefined) {
      this.sessionId = delegate.sessionId;
    }
  }

  public start(): Promise<void> {
    this.#delegate.onclose = (): void => this.onclose?.();
    this.#delegate.onerror = (error): void => this.onerror?.(error);
    this.#delegate.onmessage = <T extends JSONRPCMessage>(
      message: T,
      extra?: MessageExtraInfo,
    ): void => this.onmessage?.(normalizeIncoming(message), extra);
    return this.#delegate.start();
  }

  public send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.#delegate.send(normalizedFailure(message), options);
  }

  public close(): Promise<void> {
    return this.#delegate.close();
  }

  public setProtocolVersion(version: string): void {
    this.#delegate.setProtocolVersion?.(version);
  }
}
