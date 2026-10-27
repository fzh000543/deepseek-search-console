import { loadConfig } from './config.js';

export const state = {
  config: loadConfig(),
  lastRequest: null,
  lastResponse: null,
  chatBusy: false,
  searchBusy: false,
  agentBusy: false,
  fetchBusy: false,
};

export function rememberExchange(request, response) {
  state.lastRequest = request;
  state.lastResponse = response;
}
