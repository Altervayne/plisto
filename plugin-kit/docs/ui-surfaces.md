# UI surfaces

This page covers the things Plisto draws for your plugin: toasts, prompts and chips, the rule that stops a
background plugin from interrupting the user, and how a plugin opens its own page. For the sidebar
entries themselves see the [sidebar guide](sidebar.md); for argument and error tables see the
[API reference](api.md).

Plisto draws these surfaces, not your page, and labels each with your plugin's name. Every text is plain
text: Plisto shows it as written, so HTML appears literally. A text must not be blank and must not contain
control or invisible characters, or a run of more than 6 combining marks (`invalid_args`). Length caps count characters, not bytes; a text over its
cap is `too_large`.

## Toasts

A toast is a short message at the foot of the window. Needs the `ui.toast` capability. A background page
may show one.

```js
const r = await plisto.ui.toast("Sync finished", { action: "Details" });
if (r.result === "action") {
  plisto.ui.openPage("details", r.gesture);
}
```

- `text` is up to 140 characters. `action`, the label of an optional button, is up to 24.
- One toast shows at a time, for about 4 seconds, in the order they arrived. At most 4 toasts are open
  across all plugins; a fifth is refused `busy`.
- You may send 3 toasts at once, then one every 10 seconds. More is `rate_limited`.
- The call stays open until the toast leaves. It resolves `{ result: "dismissed" }`, or
  `{ result: "action", gesture }` when the user pressed the action button. The gesture is described below.
- A toast that waits more than 60 seconds is dismissed. If your page closes, your plugin stops or it is
  disabled, its open toasts are dismissed.

Use a toast for something the user would want to know a moment later, such as "Export finished". Do not
use one for every event.

## Prompts

A prompt asks the user a yes or no question. Needs the `ui.confirm` capability.

```js
const yes = await plisto.ui.confirm({
  title: "Delete cache?",
  body: "This frees 2 GB.",
  confirm_label: "Delete",
});
if (yes) clearCache();
```

- `title` is up to 60 characters, `body` up to 300, `confirm_label` and `cancel_label` up to 24. Without
  `cancel_label`, Plisto says "Cancel".
- Plisto shows the prompt in its own dialog, marked as coming from your plugin, with both buttons neutral.
  You cannot make a button look dangerous or primary. The SDK resolves `true` or `false`; you learn
  nothing else about what the user did.
- A plugin has one open prompt at a time (a second is `busy`), and 4 are open across all plugins (a fifth
  is `busy`). A prompt waits while another Plisto dialog is open.
- You may ask once every 10 seconds. More is `rate_limited`.
- If nobody answers in 5 minutes the call rejects `timeout` and the prompt closes. If your page closes or
  the plugin is disabled while it is open, the prompt closes and resolves `false`.
- A prompt passes through the gate described next.

## The prompt gate and gestures

A prompt (`ui.confirm`) and `ui.open_page` are allowed only when the user is plausibly present. A call
passes if either of these is true:

1. Your page is open and Plisto's window is visible and not minimized.
2. You pass a `gesture` token that is at most 5 seconds old. Plisto gives you one when the user clicks a
   toggle or an action item of your sidebar section (the `sidebar` event), or presses the action button on
   your toast.

Otherwise the call rejects with `denied` and `reason: "no_gesture"`.

How a token behaves:

- It is good for one call, for your plugin only, and for 5 seconds from when Plisto issued it.
- If you pass a token while your page is open, the first rule applies and the token stays unspent.
- A call refused earlier, for example with `busy`, does not spend the token.
- Tokens are strings. Do not store them or try to build one.

The point is to stop a background plugin from putting a dialog in front of the user for no reason. A click
on your own sidebar item is the user asking for something, so it earns one prompt.

```js
plisto.on("sidebar", async ({ item_id, gesture }) => {
  if (item_id !== "ping") return;
  try {
    const yes = await plisto.ui.confirm({
      title: "Ping?",
      body: "Send a ping now.",
      confirm_label: "Ping",
      gesture,
    });
    if (yes) sendPing();
  } catch (e) {
    if (e.code === "denied" && e.reason === "no_gesture") {
      // The token was too old, or there was no click.
    }
  }
});
```

## Chips

A chip is a short label after your plugin's name on its sidebar row, such as a count or a status word.
Needs the `ui.chips` capability.

```js
await plisto.ui.chips([{ text: "3 devices" }, { count: 2, tone: "accent" }]);
await plisto.ui.chips([]); // clears them
```

- At most 2 chips (`too_large` beyond that).
- Each chip has exactly one of `text` (up to 12 characters) or `count` (an integer from 0 to 2147483647),
  and an optional `tone`: `"neutral"` (the default), `"accent"` or `"warn"`.
- Each call replaces the previous chips. Long text is cut with an ellipsis in the row.
- Chips show on the one-row (compact) form of your sidebar entry. A plugin with a sidebar section sets a
  chip on a nav item instead, through `ui.sidebar.update` (see the [sidebar guide](sidebar.md)).
- Calls are limited to a burst of 10, then 4 per second.

## Opening your page

`plisto.ui.openPage(route?, gesture?)` asks Plisto to show your plugin's own page, at `route` when given,
or at its start when `route` is `null` or left out.

```js
plisto.ui.openPage("details");
```

- `route` is 1 to 64 visible ASCII characters. It is passed to your page, which reads it from
  `plisto.route` and the `route` event.
- It can name only your own page.
- It follows the prompt gate. From your open page it needs no gesture, so a page can change its own route
  freely. From a background page whose page is closed it needs a fresh gesture.
- It is limited to a burst of 3, then one per second.
- Plisto may still not show the page, for example when the current app mode hides the plugin. The call
  does not say.

The route is how your page knows what to show. Sidebar nav items that declare a `route`, the "Open
settings" button in Settings > Plugins (route `settings`) and `openPage` all arrive the same way, so
handle each route you declare:

```js
function render(route) {
  if (route === "settings") showSettings();
  else showHome();
}
plisto.ready.then(() => render(plisto.route));
plisto.on("route", render);
```

Treat the route as meaningful only while `plisto.pageOpen` is true.

## Which surface to use

| You want to | Use |
| --- | --- |
| Tell the user something finished | A toast |
| Get a yes or no before a risky step | A prompt |
| Show a small count or state on your sidebar row | A chip |
| Show state inside a sidebar section | A live item ([sidebar guide](sidebar.md)) |
| Let the user act without opening your page | A toggle or action item |
