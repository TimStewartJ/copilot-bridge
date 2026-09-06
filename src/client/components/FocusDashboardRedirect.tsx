import { Navigate, useLocation } from "react-router-dom";
import { getDashboardTabPath } from "../lib/dashboard-routes";

export default function FocusDashboardRedirect() {
  const location = useLocation();
  return <Navigate replace to={{
    pathname: getDashboardTabPath("focus"),
    search: location.search,
    hash: location.hash,
  }} />;
}
