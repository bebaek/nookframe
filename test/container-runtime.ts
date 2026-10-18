// The launcher isolates the test process HOME. Restore only explicitly recorded
// runtime paths when invoking Docker/Podman so local images remain discoverable.
export function containerEnvironment(): NodeJS.ProcessEnv {
  const { NOOKFRAME_TEST_CONTAINER_ENV, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, USERPROFILE, ...env } = process.env;
  return { ...env, ...JSON.parse(NOOKFRAME_TEST_CONTAINER_ENV || '{}') };
}
