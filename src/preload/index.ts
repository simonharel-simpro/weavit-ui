import { contextBridge, ipcRenderer } from 'electron'
import { buildApi } from '@shared/api'

const api = buildApi((channel, ...args) => ipcRenderer.invoke(channel, ...args))

contextBridge.exposeInMainWorld('api', api)
