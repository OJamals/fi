/**
 * Copy dictionaries for the Antigravity sign-in card.
 *
 * The zh half is never dropped: the repository's locale parity spec enforces
 * symmetric key sets between the two, so a key added here must be added
 * there in the same change.
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  title: 'Sign in with Antigravity',
  hint: 'Use your Google account to access Gemini and Claude models through Antigravity Cloud Code.',
  signIn: 'Sign in with Antigravity (Gemini Code Assist)',
  starting: 'Starting sign-in…',
  submit: 'Submit',
  cancel: 'Cancel',
  close: 'Close',
  signedIn: 'Signed in. Antigravity can now serve requests.',
  signedInRouteCreated: 'Signed in, and a route for Antigravity was added below.',
  signedInRouteAlready: 'Signed in; the route below already covered Antigravity.',
  removeSignIn: 'Remove sign-in',
  cancelled: 'Sign-in cancelled.',
  failed: 'Sign-in failed.',
  adopted: 'Antigravity is ready: a route was {route}, and it lists {count} models.',
  modelsTitle: 'Models this route now serves',
  routeCreated: 'created',
  routeAlready: 'already present',
  routeSkipped: 'blocked',
} as const

/** Chinese strings; the parity spec requires this key set to match `en` exactly. */
export const zh: Record<keyof typeof en, string> = {
  title: '使用 Antigravity 登录',
  hint: '使用您的 Google 账户通过 Antigravity Cloud Code 访问 Gemini 和 Claude 模型。',
  signIn: '使用 Antigravity (Gemini Code Assist) 登录',
  starting: '正在开始登录…',
  submit: '提交',
  cancel: '取消',
  close: '关闭',
  signedIn: '已登录。Antigravity 现在可以处理请求。',
  signedInRouteCreated: '已登录，并已在下方为 Antigravity 添加路由。',
  signedInRouteAlready: '已登录；下方路由已覆盖 Antigravity。',
  removeSignIn: '移除登录',
  cancelled: '登录已取消。',
  failed: '登录失败。',
  adopted: 'Antigravity 已就绪：路由已{route}，并列出 {count} 个模型。',
  modelsTitle: '该路由现在提供的模型',
  routeCreated: '创建',
  routeAlready: '已存在',
  routeSkipped: '受阻',
}

/** The copy keys this plugin owns. */
export type SignInKey = keyof typeof en
