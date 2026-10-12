import { fetch as pinnedFetch, getGlobalDispatcher, type Dispatcher } from "undici";

// Fetch hardcodes its own 300-second HTTP timeouts even with a longer signal.
// Override them at dispatch, without changing other requests or replaying POSTs.
// The caller's admitted signal still controls cancellation and the full deadline.
const dispatcher = {
  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
    return getGlobalDispatcher().dispatch({
      ...options, headersTimeout: 3600000, bodyTimeout: 3600000,
    }, handler);
  },
} as Dispatcher;
const transport = pinnedFetch as unknown as typeof fetch;
export const inferenceHttpFetch: typeof fetch = (input, init) => {
  const options: RequestInit & { dispatcher: Dispatcher } = {
    ...init, dispatcher, redirect: "error",
  };
  return transport(input, options);
};
