import { contextBridge, ipcRenderer } from 'electron'

// Define types for PDF generation result
interface PdfResult {
  success: boolean
  filePath?: string
  canceled?: boolean
  error?: string
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,

  // PDF generation
  generatePdf: (html: string, defaultFilename: string): Promise<PdfResult> => {
    return ipcRenderer.invoke('generate-pdf', html, defaultFilename)
  },

  // IPC communication helpers (add as needed)
  send: (channel: string, data: unknown) => {
    const validChannels = ['toMain']
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data)
    }
  },
  receive: (channel: string, func: (...args: unknown[]) => void) => {
    const validChannels = ['fromMain']
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_event, ...args) => func(...args))
    }
  }
})
