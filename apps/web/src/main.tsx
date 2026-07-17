import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { ThemeProvider } from './theme.js';
import { ToastProvider } from './toast.js';
import { Layout } from './Layout.js';
import { LoginPage } from './pages/Login.js';
import { DashboardPage } from './pages/Dashboard.js';
import { ProductsPage } from './pages/Products.js';
import { AddProductPage } from './pages/AddProduct.js';
import { ProductDetailPage } from './pages/ProductDetail.js';
import { AlertsPage } from './pages/Alerts.js';
import { SettingsPage } from './pages/Settings.js';
import { NotificationTemplatesPage } from './pages/NotificationTemplates.js';
import { ImportPage } from './pages/Import.js';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
});

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { path: '/', element: <DashboardPage /> },
      { path: '/products', element: <ProductsPage /> },
      { path: '/products/add', element: <AddProductPage /> },
      { path: '/products/:id', element: <ProductDetailPage /> },
      { path: '/alerts', element: <AlertsPage /> },
      { path: '/import', element: <ImportPage /> },
      { path: '/notifications', element: <NotificationTemplatesPage /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
