const core = require('@actions/core');
const github = require('@actions/github');
const _ = require('lodash');
const config = require('./config');

const runnersCache = {
  etag: null,
  runners: [],
  totalCount: 0,
};

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function normalizeLabels(input, isDeleteFlow) {
  if (Array.isArray(input)) {
    return input.filter(Boolean);
  }
  if (typeof input !== 'string' || input.length === 0) {
    return [];
  }
  if (!isDeleteFlow) {
    return [input];
  }
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [input];
  } catch (error) {
    return [input];
  }
}

function getRateLimitHint(error) {
  const remaining = error?.response?.headers?.['x-ratelimit-remaining'];
  if (remaining !== '0') {
    return null;
  }

  const reset = error?.response?.headers?.['x-ratelimit-reset'];
  if (!reset) {
    return 'GitHub API rate limit exceeded.';
  }

  const resetAt = new Date(Number(reset) * 1000).toISOString();
  return `GitHub API rate limit exceeded. Resets at ${resetAt}.`;
}

async function fetchAllRunners(octokit) {
  const allRunners = [];
  const perPage = 100;
  let page = 1;
  let totalCount = 0;

  while (true) {
    const requestOptions = _.merge({}, config.githubContext, { per_page: perPage, page });

    if (page === 1 && runnersCache.etag) {
      requestOptions.headers = { 'If-None-Match': runnersCache.etag };
    }

    const response = await octokit.request('GET /repos/{owner}/{repo}/actions/runners', requestOptions);

    if (response.status === 304) {
      core.info('Runners data unchanged (ETag match) - using cached data, no rate limit consumed');
      return { runners: runnersCache.runners, totalCount: runnersCache.totalCount, fromCache: true };
    }

    if (page === 1 && response.headers.etag) {
      runnersCache.etag = response.headers.etag;
    }

    const runners = response.data.runners || [];
    totalCount = response.data.total_count || 0;
    allRunners.push(...runners);

    const isLastPage = (page * perPage) >= totalCount || runners.length === 0;
    if (isLastPage) {
      break;
    }

    page += 1;
  }

  runnersCache.runners = allRunners;
  runnersCache.totalCount = totalCount;

  return { runners: allRunners, totalCount, fromCache: false };
}

// use the unique label to find the runner
// as we don't have the runner's id, it's not possible to get it in any other way
async function getRunners(label, isDeleteFlow) {
  const octokit = github.getOctokit(config.input.githubToken);
  const targetLabels = normalizeLabels(label, isDeleteFlow);

  if (targetLabels.length === 0) {
    return null;
  }

  try {
    const { runners, fromCache } = await fetchAllRunners(octokit);

    const labelsLeftToFind = new Set(targetLabels);
    const foundRunnersById = new Map();

    for (const runner of runners) {
      for (const runnerLabel of runner.labels) {
        if (labelsLeftToFind.has(runnerLabel.name)) {
          foundRunnersById.set(runner.id, runner);
          labelsLeftToFind.delete(runnerLabel.name);
        }
      }
    }

    const foundRunners = Array.from(foundRunnersById.values());
    const cacheStatus = fromCache ? ' (from cache)' : '';
    core.info(`Searched labels ${JSON.stringify(targetLabels)}. Found ${foundRunners.length} matching runner(s)${cacheStatus}.`);
    return foundRunners.length > 0 ? foundRunners : null;
  } catch (error) {
    const rateLimitHint = getRateLimitHint(error);
    if (rateLimitHint) {
      core.error(rateLimitHint);
    }
    core.error(`GitHub self-hosted runner receiving error: ${error.message}`);
    return null;
  }
}

// get GitHub Registration Token for registering a self-hosted runner
async function getRegistrationToken() {
  const octokit = github.getOctokit(config.input.githubToken);

  try {
    const response = await octokit.request('POST /repos/{owner}/{repo}/actions/runners/registration-token', config.githubContext);
    core.info('GitHub Registration Token is received');
    return response.data.token;
  } catch (error) {
    core.error('GitHub Registration Token receiving error');
    throw error;
  }
}

async function removeRunner() {
  const runners = await getRunners(config.input.label, true);
  const octokit = github.getOctokit(config.input.githubToken);

  core.info(`got runners like this in background ${JSON.stringify(runners)} and levels from config ${JSON.stringify(config.input.label)}`);

  // skip the runner removal process if the runner is not found
  if (!runners || runners.length === 0) {
    core.info(`GitHub self-hosted runner with label ${config.input.label} is not found, so the removal is skipped`);
    return;
  }

  const errors = [];
  for (const runner of runners) {
    try {
      await octokit.request('DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}', _.merge(config.githubContext, { runner_id: runner.id }));
      core.info(`GitHub self-hosted runner ${runner.name} is removed`);
    } catch (error) {
      core.error(`GitHub self-hosted runner removal error: ${error}`);
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    core.setFailed('Failures occurred when removing runners.');
  }
}

function getOfflineLabels(labels, runners) {
  const expectedLabels = new Set(labels);
  const onlineLabels = new Set();

  for (const runner of (runners || [])) {
    if (runner.status !== 'online') {
      continue;
    }
    for (const runnerLabel of runner.labels) {
      if (expectedLabels.has(runnerLabel.name)) {
        onlineLabels.add(runnerLabel.name);
      }
    }
  }

  return labels.filter((label) => !onlineLabels.has(label));
}

async function waitForLabelsRegistered(labels, timeoutMinutes, initialRetryIntervalSeconds, quietPeriodSeconds) {
  const expectedLabels = normalizeLabels(labels, false);
  let waitSeconds = 0;
  let retryIntervalSeconds = initialRetryIntervalSeconds;
  const maxRetryIntervalSeconds = 120;

  if (quietPeriodSeconds > 0) {
    core.info(`Waiting ${quietPeriodSeconds}s for the AWS EC2 instances to be registered in GitHub as new self-hosted runners`);
    await sleep(quietPeriodSeconds);
  }

  core.info(`Checking with exponential backoff (starting at ${retryIntervalSeconds}s, max ${maxRetryIntervalSeconds}s) if the GitHub self-hosted runners are registered`);

  while (waitSeconds <= timeoutMinutes * 60) {
    const runners = await getRunners(expectedLabels, false);
    const offlineLabels = getOfflineLabels(expectedLabels, runners);

    if (offlineLabels.length === 0) {
      core.info(`GitHub self-hosted runners for labels ${JSON.stringify(expectedLabels)} are registered and ready to use`);
      return;
    }

    core.info(`Waiting ${retryIntervalSeconds}s before next check. Labels still pending: ${JSON.stringify(offlineLabels)}`);
    await sleep(retryIntervalSeconds);
    waitSeconds += retryIntervalSeconds;
    retryIntervalSeconds = Math.min(Math.floor(retryIntervalSeconds * 1.5), maxRetryIntervalSeconds);
  }

  throw new Error(
    `A timeout of ${timeoutMinutes} minutes is exceeded. Your AWS EC2 instances with labels ${JSON.stringify(expectedLabels)} were not able to register as new GitHub self-hosted runners.`
  );
}

async function waitForRunnerRegistered(label, timeoutMinutes, retryIntervalSeconds) {
  return waitForLabelsRegistered([label], timeoutMinutes, retryIntervalSeconds, 0);
}

async function waitForRunnersRegistered(labels) {
  const timeoutMinutes = 7;
  const initialRetryIntervalSeconds = 30;
  const quietPeriodSeconds = 120; // Wait 2 min for EC2 to boot before first poll

  return waitForLabelsRegistered(labels, timeoutMinutes, initialRetryIntervalSeconds, quietPeriodSeconds);
}

module.exports = {
  getRegistrationToken,
  removeRunner,
  waitForRunnerRegistered,
  waitForRunnersRegistered,
  getRunners,
};
