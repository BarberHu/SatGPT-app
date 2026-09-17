import React from 'react';
import ReactDOM from 'react-dom/client';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import './styles/main.css';
import App from './App';
import { AppProvider } from './context/AppContext';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <AppProvider>
      <App />
    </AppProvider>
  </React.StrictMode>
);
