import { expect, it } from "bun:test";
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Route } from "../connect";

it("redirects old Connect links into the subshell launcher with choices preserved", async () => {
  const root = createRootRoute();
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/connect",
        validateSearch: Route.options.validateSearch,
        beforeLoad: Route.options.beforeLoad,
      }),
      createRoute({ getParentRoute: () => root, path: "/new", validateSearch: (search) => search }),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/connect?node=desk&destination=deploy%40box%3A2222&keyHome=laptop&requestId=req"],
    }),
  });
  await router.load();
  expect(router.state.location.pathname).toBe("/new");
  expect(router.state.location.search).toMatchObject({
    kind: "ssh",
    node: "desk",
    destination: "deploy@box:2222",
    keyHome: "laptop",
  });
});
