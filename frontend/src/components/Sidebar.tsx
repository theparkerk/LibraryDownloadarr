import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api, getSelectedServerId, selectServer } from '../services/api';
import { Library, ServerInfo } from '../types';
import { useAuthStore } from '../stores/authStore';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isOpen, onClose }) => {
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const selectedServerId = getSelectedServerId();

  useEffect(() => {
    loadLibraries();
    loadServers();
  }, []);

  const loadLibraries = async () => {
    try {
      const data = await api.getLibraries();
      setLibraries(data);
    } catch (error) {
      console.error('Failed to load libraries:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadServers = async () => {
    try {
      const data = await api.getServers();
      setServers(data);
      // A stale selection (e.g. a server no longer shared with this
      // account) would 403 every request — snap back to home. 'all' stays
      // valid whenever there's more than one server.
      const selected = getSelectedServerId();
      if (
        selected !== 'home' &&
        selected !== 'all' &&
        !data.some((s) => s.machineId === selected)
      ) {
        selectServer('home');
      } else if (selected === 'all' && data.length <= 1) {
        selectServer('home');
      }
    } catch (error) {
      console.error('Failed to load servers:', error);
    }
  };

  const serverValue =
    selectedServerId === 'all' && servers.length > 1
      ? 'all'
      : servers.some((s) => s.machineId === selectedServerId && !s.isHome)
      ? selectedServerId
      : 'home';

  const isActive = (path: string) => location.pathname === path;

  const handleNavigate = (path: string) => {
    navigate(path);
    onClose(); // Close mobile menu after navigation
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed md:static inset-y-0 left-0 z-50
          w-64 bg-dark-100 border-r border-dark-50
          transform transition-transform duration-300 ease-in-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{
          paddingTop: 'calc(1rem + env(safe-area-inset-top))',
          paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
          paddingLeft: 'calc(1rem + env(safe-area-inset-left))',
          paddingRight: '1rem',
        }}
      >
        <nav className="space-y-2">
          {servers.length > 1 && (
            <div className="px-2 pb-2">
              <label className="block px-2 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Server
              </label>
              <select
                value={serverValue}
                onChange={(e) => selectServer(e.target.value)}
                className="w-full bg-dark-200 border border-dark-50 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
              >
                <option value="all">🌐 All Servers</option>
                {servers.map((server) => (
                  <option
                    key={server.machineId}
                    value={server.isHome ? 'home' : server.machineId}
                  >
                    {server.name}
                    {server.isHome ? ' (home)' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            onClick={() => handleNavigate('/')}
            className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
              isActive('/') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
            }`}
          >
            🏠 Home
          </button>

          {user?.isAdmin && (
            <>
              <button
                onClick={() => handleNavigate('/admin/download-history')}
                className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                  isActive('/admin/download-history') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                📊 Download History
              </button>
              <button
                onClick={() => handleNavigate('/admin/logs')}
                className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                  isActive('/admin/logs') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                📋 Logs
              </button>
              <button
                onClick={() => handleNavigate('/settings')}
                className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                  isActive('/settings') ? 'bg-dark-200 text-primary-400' : 'hover:bg-dark-200'
                }`}
              >
                ⚙️ Settings
              </button>
            </>
          )}

          {isLoading ? (
            <div className="px-4 py-2 text-sm text-gray-500">Loading libraries...</div>
          ) : (
            <>
              <div className="pt-4 pb-2 px-4 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Libraries
              </div>
              {libraries.map((library) => (
                <button
                  key={library.key}
                  onClick={() => handleNavigate(`/library/${library.key}`)}
                  className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
                    location.pathname === `/library/${library.key}`
                      ? 'bg-dark-200 text-primary-400'
                      : 'hover:bg-dark-200'
                  }`}
                >
                  <div className="flex items-center space-x-2">
                    <span>
                      {library.type === 'movie'
                        ? '🎬'
                        : library.type === 'show'
                        ? '📺'
                        : library.type === 'artist'
                        ? '🎵'
                        : '📁'}
                    </span>
                    <span className="truncate">{library.title}</span>
                  </div>
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>
    </>
  );
};
