/**
 * Import-time step that maps each inherited runtime `FI_<NAME>` variable
 * (`FI_RUNTIME_ENVIRONMENT_NAMES`) onto `DSH_<NAME>` in `process.env` (the `FI_` value wins). Entry modules import it
 * first so that no module evaluated after it observes the unaliased environment.
 * @module @deepseek-ai/dsh/fi-environment
 */

import { fiEnvironmentAliases } from '@deepseek-ai/dsh-home-paths'

Object.assign(process.env, fiEnvironmentAliases(process.env))
