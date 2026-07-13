import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    // Open devtools in production for debugging
    mainWindow.webContents.openDevTools()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Allow blank windows for printing functionality
    if (details.url === '' || details.url === 'about:blank') {
      return { action: 'allow' }
    }
    // Open external URLs in system browser
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Load the remote URL for development or the local html file for production
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.dicompare')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// IPC handler for PDF generation
ipcMain.handle('generate-pdf', async (_event, html: string, defaultFilename: string) => {
  // Create a hidden window to render the HTML
  const pdfWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      offscreen: true
    }
  })

  try {
    // Load the HTML content
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    // Wait for content to be fully rendered
    await new Promise(resolve => setTimeout(resolve, 500))

    // Generate PDF
    const pdfData = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      margins: {
        top: 0.5,
        bottom: 0.5,
        left: 0.5,
        right: 0.5
      }
    })

    // Show save dialog
    const { filePath, canceled } = await dialog.showSaveDialog({
      defaultPath: defaultFilename,
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
    })

    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    // Save the PDF
    await writeFile(filePath, pdfData)

    // Open the PDF with the system's default viewer
    shell.openPath(filePath)

    return { success: true, filePath }
  } catch (error) {
    console.error('PDF generation failed:', error)
    return { success: false, error: String(error) }
  } finally {
    pdfWindow.close()
  }
})
