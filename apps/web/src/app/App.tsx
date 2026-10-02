import { ProLayout } from '@ant-design/pro-components';
import { useAuth0 } from '@auth0/auth0-react';
import { theme as antdTheme, Button, Dropdown, Spin, Typography } from 'antd';
import { Activity, BarChart3, Server, Workflow } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useUserMenu } from '../shared/components/user-menu';

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

  const avatarMenu = useUserMenu({
    nickname,
    email: userEmail,
    avatarUrl: user?.picture,
    initials: userInitials,
    onLogout: handleLogout,
  });

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
      logo="/ag.png"
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
            className="user-dropdown"
          >
            <span style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {dom}
            </span>
          </Dropdown>
        ),
      }}
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
