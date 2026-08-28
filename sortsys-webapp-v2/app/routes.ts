import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
    route("__admin/login", "routes/(admin)/__admin.login.tsx"),
    route("__admin", "routes/(admin)/__admin._layout.tsx", [
        index("routes/(admin)/__admin.index.tsx"),
        route("tenants", "routes/(admin)/__admin.tenants.tsx"),
        route("databases", "routes/(admin)/__admin.databases.tsx"),
        route("errors", "routes/(admin)/__admin.errors.tsx"),
        route("llm", "routes/(admin)/__admin.llm.tsx"),
        route("*", "routes/(admin)/__admin.not-found.tsx"),
    ]),

    route("auth/login", "routes/auth/login.tsx"),

    route(null, "routes/(shell)/_layout.tsx", [
        index("routes/(shell)/index.tsx"),
        route("dashboard", "routes/(shell)/dashboard.tsx"),
        route("settings", "routes/(shell)/settings.shell.tsx", [
            index("routes/(shell)/settings.tsx"),
            route("passkeys", "routes/(shell)/settings.passkeys.tsx"),
            route("language", "routes/(shell)/settings.language.tsx"),
        ]),
        route("docs", "routes/(shell)/docs.tsx"),
        route("docs/:id", "routes/(shell)/docs.$id.tsx"),
        route("scripts", "routes/(shell)/scripts.tsx"),
        route("deployments", "routes/(shell)/deployments.tsx"),
        route("vacations", "routes/(shell)/vacations.tsx"),
        route("llm/chats", "routes/(shell)/llm.chats.tsx"),
        route("llm/:chatId?", "routes/(shell)/llm.tsx"),

        route("projects", "routes/(shell)/projects.shell.tsx", [
            index("routes/(shell)/projects.index.tsx"),
            route("costs", "routes/(shell)/projects.costs.tsx"),
        ]),
        route("projects/:id", "routes/(shell)/projects.$id.shell.tsx", [
            index("routes/(shell)/projects.$id.index.tsx"),
            route("files", "routes/(shell)/projects.$id.files.tsx"),
            route("costs", "routes/(shell)/projects.$id.costs.tsx"),
            route("regieReports", "routes/(shell)/projects.$id.regieReports.tsx"),
            route("dailyReports", "routes/(shell)/projects.$id.dailyReports.tsx"),
        ]),
        route("regieReports/:id", "routes/(shell)/regieReports.$id.tsx"),
        route("projects/:id/dailyReports/:day", "routes/(shell)/projects.dailyReports.$day.tsx"),

        route("users", "routes/(shell)/users.shell.tsx", [
            index("routes/(shell)/users.index.tsx"),
            route("supervisors", "routes/(shell)/users.supervisors.tsx"),
        ]),
        route("users/:id", "routes/(shell)/users.$id.tsx"),

        route("tools", "routes/(shell)/tools.shell.tsx", [
            index("routes/(shell)/tools.index.tsx"),
            route("trackings", "routes/(shell)/tools.trackings.tsx"),
            route("transferRequests", "routes/(shell)/tools.transferRequests.tsx"),
        ]),
        route("tools/:id", "routes/(shell)/tools.$id.tsx"),

        route("products", "routes/(shell)/products.shell.tsx", [
            index("routes/(shell)/products.index.tsx"),
            route("deliveryNotes", "routes/(shell)/products.deliveryNotes.tsx"),
            route("vendors", "routes/(shell)/products.vendors.tsx"),
        ]),
        route("products/:id", "routes/(shell)/products.$id.tsx"),
        route("products/deliveryNotes/:id", "routes/(shell)/products.deliveryNotes.$id.tsx"),
        route("products/vendors/:id", "routes/(shell)/products.vendors.$id.tsx"),

        route("contacts", "routes/(shell)/contacts.tsx"),
        route("contacts/:id", "routes/(shell)/contacts.$id.tsx"),

        route("inventories", "routes/(shell)/inventories.tsx"),

        route("customers", "routes/(shell)/customers.tsx"),
        route("customers/:id", "routes/(shell)/customers.$id.tsx"),

        route("admin", "routes/(shell)/admin.tsx"),
        
        route("*", "routes/(shell)/_404.tsx"),
    ]),
] satisfies RouteConfig;
