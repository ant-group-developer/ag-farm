import './i18n/config';
import './styles.css';
import './login.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { NuqsAdapter } from 'nuqs/adapters/react-router';
import { App } from './app/App';
import { AppProviders } from './app/providers';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <NuqsAdapter>
        <AppProviders>
          <App />
        </AppProviders>
      </NuqsAdapter>
    </BrowserRouter>
  </React.StrictMode>,
);
