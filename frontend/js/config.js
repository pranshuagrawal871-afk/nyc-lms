// Shared backend origin for frontend API and backend-hosted media paths.
const API_BASE_URL = (window.__API_BASE_URL__ || 'https://nyc-lms-backend.onrender.com').replace(/\/+$/, '');

function apiUrl(path) {
  if (!path) return API_BASE_URL;
  if (/^https?:\/\//i.test(path)) return path;
  return API_BASE_URL + (path.startsWith('/') ? path : '/' + path);
}
