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
  signInAgain: 'Sign in again',
  signInAgainFor: 'Sign in to {provider} again',
  starting: 'Starting sign-in…',
  submit: 'Submit',
  cancel: 'Cancel',
  close: 'Close',
  signedIn: 'Signed in. This provider can now serve requests.',
  signedInRouteCreated: 'Signed in, and a provider entry for {provider} was added.',
  signedInRouteAlready: 'Signed in; a provider entry already covered {provider}.',
  removeSignIn: 'Remove sign-in',
  removeSignInFor: 'Remove {provider} sign-in',
  cancelled: 'Sign-in cancelled.',
  failed: 'Sign-in failed.',
  footerTitle: 'Sign in with your subscription',
  footerHint: 'Use an existing subscription without an API key. Sign in once, then add the provider to Models.',
  footerProvider: 'Subscription provider',
  footerAttempt: 'Sign-in with {provider}',
  footerLoading: 'Loading subscription sign-ins…',
  footerLoadError: 'Unable to load subscription sign-ins: {message}',
  retry: 'Retry',
  footerAdopted: '{provider} is ready: a provider entry was {route}, and it lists {count} models.',
  footerModelsTitle: 'Models this provider entry serves',
  adoptAction: 'Add provider',
  adoptActionFor: 'Add {provider} provider',
  setupAction: 'Set up provider',
  setupActionFor: 'Set up {provider} provider',
  nativeSetupHint: 'Use the stored subscription sign-in to add this provider to Models.',
  nativeSetupSignInHint: 'Use the “Sign in with your subscription” section below, then return here to set up this provider.',
  footerRouteCreated: 'created',
  footerError: 'Could not complete the subscription sign-in action: {message}',
  footerRouteAlready: 'already present',
  footerRouteSkipped: 'blocked',
} as const

/** Chinese strings; the parity spec requires this key set to match `en` exactly. */
export const zh: Record<keyof typeof en, string> = {
  subscriptionHint: '或使用你的订阅登录',
  stateSignedIn: '已登录',
  stateSignedOut: '未登录',
  signInAgain: '重新登录',
  signInAgainFor: '重新登录 {provider}',
  starting: '正在开始登录…',
  submit: '提交',
  cancel: '取消',
  close: '关闭',
  signedIn: '已登录。该提供方现在可以处理请求。',
  signedInRouteCreated: '已登录，并已为 {provider} 添加提供方条目。',
  signedInRouteAlready: '已登录；已有提供方条目覆盖 {provider}。',
  removeSignIn: '移除登录',
  removeSignInFor: '移除 {provider} 登录',
  cancelled: '登录已取消。',
  failed: '登录失败。',
  footerTitle: '使用您的订阅登录',
  footerHint: '无需 API 密钥即可使用已有订阅。登录一次后，将该提供方添加到模型页面。',
  footerProvider: '订阅提供方',
  footerAttempt: '正在使用 {provider} 登录',
  footerLoading: '正在加载订阅登录方式…',
  footerLoadError: '无法加载订阅登录方式：{message}',
  retry: '重试',
  footerAdopted: '{provider} 已就绪：提供方条目已{route}，并列出 {count} 个模型。',
  footerModelsTitle: '该提供方条目提供的模型',
  adoptAction: '添加提供方',
  adoptActionFor: '添加 {provider} 提供方',
  setupAction: '设置提供方',
  setupActionFor: '设置 {provider} 提供方',
  nativeSetupHint: '使用已保存的订阅登录将此提供方添加到模型页面。',
  nativeSetupSignInHint: '请先使用下方「使用您的订阅登录」区块，再返回此处设置该提供方。',
  footerRouteCreated: '创建',
  footerError: '无法完成订阅登录操作：{message}',
  footerRouteAlready: '已存在',
  footerRouteSkipped: '受阻',
}

/** The copy keys this plugin owns. */
export type SignInKey = keyof typeof en
