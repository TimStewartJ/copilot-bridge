import { Navigate, useLocation } from "react-router-dom";
import { getDashboardTabPath } from "../lib/dashboard-routes";

const RETIRED_RECORD_PARAMS = ["focus", "episode", "id", "invalidLink"];

/** Old Focus, Feed, checklist and archive links land on Home; the records they named no longer exist. */
export default function FocusDashboardRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  for (const name of RETIRED_RECORD_PARAMS) params.delete(name);
  const search = params.toString();
  return <Navigate replace to={{ pathname: getDashboardTabPath("focus"), search: search ? `?${search}` : "", hash: location.hash }} />;
}
