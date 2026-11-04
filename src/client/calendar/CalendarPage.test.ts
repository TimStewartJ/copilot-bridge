import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import CalendarPage from "./CalendarPage";
import { calendarEntryState } from "./calendar-entry";

vi.mock("./calendar-api", async (original) => ({ ...await original<typeof import("./calendar-api")>(), useCalendarQuery: () => ({}) }));

it("keeps the return to Home one step away while browsing other dates and views", async () => {
  const state = calendarEntryState("home", "home-calendar");
  const harness = await createReactDomHarness();
  const client = new QueryClient();
  let returnState: unknown;
  function Flow() {
    const location = useLocation(), navigate = useNavigate();
    returnState = location.state;
    if (location.pathname !== "/calendar") return createElement("output", null, location.pathname);
    return createElement(CalendarPage, { onSelectTask: vi.fn(), mobileBack: {
      label: "Home", onBack: () => navigate(-1),
    } });
  }
  await harness.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, {
    initialEntries: ["/dashboard/home", { pathname: "/calendar", search: "?date=2026-04-06", state }],
  }, createElement(Flow))));
  const click = async (name: string) => {
    const button = findAllByTag(harness.dom.container, "BUTTON").find((el) =>
      getReactProps(el)?.["aria-label"] === name || el.textContent === name);
    expect(button, name).toBeDefined();
    await harness.act(async () => { getReactProps(button)?.onClick(); });
  };
  await click("Week");
  await click("Later");
  expect(returnState).toEqual(state);
  await click("Back to Home");
  expect(harness.dom.container.textContent).toBe("/dashboard/home");
  await harness.cleanup();
  client.clear();
});
