import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { ServerProvider } from './state/ServerProvider'
import { Shell } from './components/Shell'
import { Command } from './pages/Command'
import { Dossier } from './pages/Dossier'
import { Timeline } from './pages/Timeline'
import { Retracer } from './pages/Retracer'
import { RaidPlanner } from './pages/RaidPlanner'
import { BaseLibrary } from './pages/BaseLibrary'
import { Servers } from './pages/Servers'
import { Settings } from './pages/Settings'
import { Onboarding } from './pages/Onboarding'

const router = createBrowserRouter([
  { path: '/onboarding', element: <Onboarding /> },
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Command /> },
      { path: 'dossier', element: <Dossier /> },
      { path: 'timeline', element: <Timeline /> },
      { path: 'retracer', element: <Retracer /> },
      { path: 'raid', element: <RaidPlanner /> },
      { path: 'bases', element: <BaseLibrary /> },
      { path: 'servers', element: <Servers /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
], {
  // Opt in to v7 behaviour now so the upgrade is a no-op.
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
})

export default function App() {
  return (
    <ServerProvider>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </ServerProvider>
  )
}
