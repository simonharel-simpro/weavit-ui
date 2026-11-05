// Web-mode entry: install the HTTP transport as `window.api` (what the Electron
// preload does over IPC), then load the unchanged app. The dynamic import keeps
// lib/api.ts from reading `window.api` before it exists.
import { buildApi } from '@shared/api'
import { createFetchInvoke } from '@shared/webInvoke'

window.api = buildApi(createFetchInvoke())
void import('./main')
