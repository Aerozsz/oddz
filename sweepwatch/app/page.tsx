import Dashboard from "../components/Dashboard";

// Nothing here is prerenderable: every number on the page comes from a live
// socket in the visitor's own browser.
export const dynamic = "force-static";

export default function Page() {
  return <Dashboard />;
}
