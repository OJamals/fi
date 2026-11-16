/**
 * Import-time step that maps each inherited runtime `FI_<NAME>` variable
 * (`FI_RUNTIME_ENVIRONMENT_NAMES`) onto `DSH_<NAME>` in `process.env` (the `FI_` value wins). The entry module imports
 * it first so that no module evaluated after it observes the unaliased environment.
 */

import { fiEnvironmentAliases } from '@deepseek-ai/dsh-home-paths'

Object.assign(process.env, fiEnvironmentAliases(process.env))
