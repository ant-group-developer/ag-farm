import { ProLayout } from '@ant-design/pro-components';
import { useAuth0 } from '@auth0/auth0-react';
import { theme as antdTheme, Button, Dropdown, Select, Spin, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { Activity, BarChart3, LogOut, Server, Workflow } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  APP_LANGUAGES,
  LANGUAGE_NAMES,
  changeLanguage,
  currentLanguage,
  type AppLanguage,
} from '../i18n/language';

const NodesPage = lazy(() =>
  import('../modules/nodes/NodesPage').then(({ NodesPage }) => ({ default: NodesPage })),
);
const JobsPage = lazy(() =>
  import('../modules/jobs/JobsPage').then(({ JobsPage }) => ({ default: JobsPage })),
);
const StatsPage = lazy(() =>
  import('../modules/stats/StatsPage').then(({ StatsPage }) => ({ default: StatsPage })),
);
const OwnersPage = lazy(() =>
  import('../modules/owners/OwnersPage').then(({ OwnersPage }) => ({ default: OwnersPage })),
);

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth0();
  const { token } = antdTheme.useToken();
  const { t } = useTranslation();

  const userEmail = user?.email ?? '';
  const userInitials = userEmail.slice(0, 2).toUpperCase();
  const nickname = user?.name ?? userEmail;

  const handleLogout = () => {
    void logout({ logoutParams: { returnTo: window.location.origin } });
  };

  const avatarMenu: MenuProps = {
    items: [
      {
        key: 'user',
        label: (
          <div style={{ padding: '4px 0' }}>
            <Typography.Text strong>{nickname}</Typography.Text>
            <br />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {userEmail}
            </Typography.Text>
          </div>
        ),
        disabled: true,
      },
      { type: 'divider' },
      {
        key: 'logout',
        icon: <LogOut size={14} />,
        label: t('app.logout'),
        onClick: handleLogout,
        danger: true,
      },
    ],
  };

  const route = {
    path: '/',
    routes: [
      {
        path: '/stats',
        name: t('menu.stats'),
        icon: <BarChart3 size={16} />,
      },
      {
        path: '/nodes',
        name: t('menu.nodes'),
        icon: <Server size={16} />,
      },
      {
        path: '/jobs',
        name: t('menu.jobs'),
        icon: <Workflow size={16} />,
      },
      {
        path: '/owners',
        name: t('menu.owners'),
        icon: <Activity size={16} />,
      },
    ],
  };

  return (
    <ProLayout
      title={t('app.title')}
      siderWidth={200}
      layout="mix"
      fixSiderbar
      fixedHeader
      siderMenuType="group"
      location={{ pathname: location.pathname }}
      route={route}
      token={{
        sider: {
          colorTextMenuSelected: token.colorPrimary,
          colorBgMenuItemSelected: token.colorPrimaryBg,
        },
      }}
      menuItemRender={(item, dom) => (item.path ? <Link to={item.path}>{dom}</Link> : dom)}
      onMenuHeaderClick={() => navigate('/stats')}
      contentStyle={{ padding: 24 }}
      avatarProps={{
        src: user?.picture,
        size: 'small',
        style: { backgroundColor: token.colorPrimary },
        children: !user?.picture ? userInitials : undefined,
        title: <span style={{ fontSize: 14, fontWeight: 500 }}>{nickname}</span>,
        render: (_props, dom) => (
          <Dropdown
            menu={avatarMenu}
            trigger={['click']}
            placement="bottomRight"
          >
            <span style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {dom}
            </span>
          </Dropdown>
        ),
      }}
      actionsRender={() => [
        <Select<AppLanguage>
          key="language"
          size="small"
          aria-label={t('common.language')}
          value={currentLanguage()}
          style={{ width: 120 }}
          options={APP_LANGUAGES.map((lng) => ({ value: lng, label: LANGUAGE_NAMES[lng] }))}
          onChange={(lng) => void changeLanguage(lng)}
        />,
        <Button key="logout" size="small" onClick={handleLogout} icon={<LogOut size={14} />}>
          {t('app.logout')}
        </Button>,
      ]}
    >
      <Suspense fallback={<Spin fullscreen />}>
        <Routes>
          <Route path="/" element={<Navigate to="/stats" replace />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/owners" element={<OwnersPage />} />
          <Route
            path="*"
            element={
              <div style={{ textAlign: 'center', padding: 48 }}>
                <Typography.Title level={3}>{t('app.notFound')}</Typography.Title>
                <Button onClick={() => navigate('/stats')}>{t('app.backHome')}</Button>
              </div>
            }
          />
        </Routes>
      </Suspense>
    </ProLayout>
  );
}
