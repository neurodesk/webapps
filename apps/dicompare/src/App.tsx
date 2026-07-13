import React from 'react';
import { HashRouter, BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { SchemaProvider } from './contexts/SchemaContext';
import LandingPage from './pages/LandingPage';
import UnifiedWorkspacePage from './pages/UnifiedWorkspacePage';
import SchemaViewerPage from './pages/SchemaViewerPage';

// Use HashRouter for Electron (file:// protocol), BrowserRouter for web
const isElectron = typeof window !== 'undefined' &&
  (window.location.protocol === 'file:' || navigator.userAgent.includes('Electron'));
const Router = isElectron ? HashRouter : BrowserRouter;
const rawBase = import.meta.env.BASE_URL.replace(/\/$/, '');
const basename = isElectron ? undefined : (rawBase === '.' || rawBase === '') ? '' : rawBase;

function App() {
  return (
    <ThemeProvider>
      <SchemaProvider>
        <Router basename={basename}>
          <div className="min-h-screen bg-surface text-content-primary">
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/schema/:id" element={<SchemaViewerPage />} />
              <Route path="/schema" element={<SchemaViewerPage />} />
              <Route path="/workspace/*" element={<UnifiedWorkspacePage />} />
              {/* Redirect legacy routes to workspace */}
              <Route path="/schema-builder/*" element={<Navigate to="/workspace" replace />} />
              <Route path="/compliance-checker/*" element={<Navigate to="/workspace" replace />} />
            </Routes>
          </div>
        </Router>
      </SchemaProvider>
    </ThemeProvider>
  );
}

export default App;
