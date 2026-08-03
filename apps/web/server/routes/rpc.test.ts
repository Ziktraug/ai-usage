import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { requestWithConnectionSignal } from './rpc';

const request = (signal?: AbortSignal): Request =>
  new Request('http://127.0.0.1:3000/rpc/runtime/reportPerfEnabled', signal === undefined ? {} : { signal });

describe('RPC route connection signal', () => {
  test('preserves the original request when no native socket is available', () => {
    const original = request();

    expect(requestWithConnectionSignal(original, undefined, undefined)).toBe(original);
  });

  test('aborts the handler request and removes lifecycle listeners when the socket closes', () => {
    const socket = new EventEmitter();
    const response = new EventEmitter();
    const connected = requestWithConnectionSignal(request(), socket, response);

    socket.emit('close');

    expect(connected.signal.aborted).toBe(true);
    expect(connected.signal.reason).toBeInstanceOf(Error);
    expect(socket.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
  });

  test('removes the socket listener after a normally finished response', () => {
    const socket = new EventEmitter();
    const response = new EventEmitter();
    const connected = requestWithConnectionSignal(request(), socket, response);

    response.emit('finish');
    socket.emit('close');

    expect(connected.signal.aborted).toBe(false);
    expect(socket.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
  });

  test('forwards the original abort reason and removes native listeners', () => {
    const originalController = new AbortController();
    const socket = new EventEmitter();
    const response = new EventEmitter();
    const connected = requestWithConnectionSignal(request(originalController.signal), socket, response);
    const reason = new Error('Synthetic upstream cancellation.');

    originalController.abort(reason);

    expect(connected.signal.aborted).toBe(true);
    expect(connected.signal.reason).toBe(reason);
    expect(socket.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
  });
});
