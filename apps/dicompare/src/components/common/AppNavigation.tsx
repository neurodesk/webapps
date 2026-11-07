import React from 'react';
import { NavLink } from 'react-router-dom';
import { BookOpen, Home, Layers } from 'lucide-react';
import { UPSTREAM_RELEASE } from '../../upstreamRelease';

// The shared Neurodesk bar replaces each page's header, which carried these
// links, so dicompare's own pages and its upstream release stay visible in a
// strip under the bar.
const links = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/workspace', label: 'Workspace', icon: Layers, end: false },
  { to: '/schema', label: 'Schema Library', icon: BookOpen, end: false },
];

const AppNavigation: React.FC = () => (
  <nav aria-label="dicompare" className="shrink-0 border-b border-border bg-surface-primary">
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center gap-x-1 py-1">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
            isActive
              ? 'text-brand-600 bg-surface-secondary'
              : 'text-content-secondary hover:text-content-primary hover:bg-surface-secondary'
          }`}
        >
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </NavLink>
      ))}
      <a
        href={`https://github.com/astewartau/dicompare-web/releases/tag/v${UPSTREAM_RELEASE}`}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto px-2 py-1 whitespace-nowrap text-xs text-content-tertiary hover:text-content-primary transition-colors"
        title="The dicompare-web release this deployment is synced to"
      >
        dicompare-web v{UPSTREAM_RELEASE}
      </a>
    </div>
  </nav>
);

export default AppNavigation;
