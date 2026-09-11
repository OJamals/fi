/**
 * Copy dictionaries for the subscription sign-in card.
 *
 * The zh half is never dropped: the repository's locale parity spec enforces
 * symmetric key sets between the two, so a key added here must be added
 * there in the same change.
 */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  subscriptionHint: 'Or sign in with your subscription',
  stateSignedIn: 'Signed in',
  stateSignedOut: 'Not signed in',
  signInAgain: 'Sign in again ({method})',
  starting: 'Starting sign-in…',
  submit: 'Submit',
  cancel: 'Cancel',
  close: 'Close',
  signedIn: 'Signed in. This provider can now serve requests.',
  signedInRouteCreated: 'Signed in, and a route for {provider} was added below.',
  signedInRouteAlready: 'Signed in; the route below already covered {provider}.',
  removeSignIn: 'Remove sign-in',
  cancelled: 'Sign-in cancelled.',
  failed: 'Sign-in failed.',
  footerTitle: 'Sign in with your subscription',
  footerHint: 'Add these providers without an API key: a one-time sign-in authorizes fi, and their models are listed under the route below.',
  footerAdopted: '{provider} is ready: a route was {route}, and it lists {count} models.',
  footerModelsTitle: 'Models this route now serves',
  adoptAction: 'Add {provider}',
  footerRouteCreated: 'created',
  footerRouteAlready: 'already present',
  footerRouteSkipped: 'blocked',
} as const

/** Chinese strings; the parity spec requires this key set to match `en` exactly. */
export const zh: Record<keyof typeof en, string> = {
  subscriptionHint: '或使用你的订阅登录',
  stateSignedIn: '已登录',
  stateSignedOut: '未登录',
  signInAgain: '重新登录（{method}）',
  starting: '正在开始登录…',
  submit: '提交',
  cancel: '取消',
  close: '关闭',
  signedIn: '已登录。该提供方现在可以处理请求。',
  signedInRouteCreated: '已登录，并已在下方为 {provider} 添加路由。',
  signedInRouteAlready: '已登录；下方路由已覆盖 {provider}。',
  removeSignIn: '移除登录',
  cancelled: '登录已取消。',
  failed: '登录失败。',
  footerTitle: '使用您的订阅登录',
  footerHint: '无需 API 密钥即可添加以下提供方：一次登录授权 fi，其模型将列在下方路由中。',
  footerAdopted: '{provider} 已就绪：路由已{route}，并列出 {count} 个模型。',
  footerModelsTitle: '该路由现在提供的模型',
  adoptAction: '添加 {provider}',
  footerRouteCreated: '创建',
  footerRouteAlready: '已存在',
  footerRouteSkipped: '受阻',
}

/** The copy keys this plugin owns. */
export type SignInKey = keyof typeof en
