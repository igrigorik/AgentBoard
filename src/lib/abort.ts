export function raceWithAbort<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}
