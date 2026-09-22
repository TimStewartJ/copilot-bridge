import { Navigate, useLocation } from "react-router-dom";
import { getDashboardTabPath } from "../lib/dashboard-routes";

export default function FocusDashboardRedirect() {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const source = params.get("focus")?.trim();
  if ((params.has("focus") && (!source || params.getAll("focus").length !== 1))
    || (params.has("episode") && (!source || !params.get("episode")?.trim() || params.getAll("episode").length !== 1))) {
    return <Navigate replace to="/dashboard/archive?invalidLink=true" />;
  }
  const archived = new URLSearchParams();
  if (source) archived.set("id", source);
  if (params.get("episode")) archived.set("episode", params.get("episode")!);
  return <Navigate replace to={{
    pathname: source ? "/dashboard/archive" : getDashboardTabPath("focus"),
    search: source ? `?${archived}` : location.search,
    hash: location.hash,
  }} />;
}
