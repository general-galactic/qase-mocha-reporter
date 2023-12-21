# qase-mocha-reporter

A mocha reporter that will uploaded automated test results into Qase Test Runs for a project.

## Usage

1. Install the reporter: `npm i -D @general-galactic/qase-mocha-reporter`
2. Configure mocha to use the reporter: `--reporter @general-galactic/qase-mocha-reporter`
3. Set up the required environment parameters:
    * `QASE_API_TOKEN` - An API token obtained from your Qase account.
    * `QASE_PROJECT_CODE` - The short project code found in your Qase project settings.
    * `QASE_TEST_RUN_TITLE` - The title used for a test run. This can be constructed dynamically on your CI system. Here's an example for Github Actions: `${{ github.event.head_commit.message }} - ${{ github.run_number }} on Node v${{ matrix.node-version }}`.
    * `QASE_TEST_RUN_TAGS` - A comma separated list of tags that will be added to each test run.
4. Run your tests and see what happens.

## Debugging

You can add `DEBUG=qase-mocha-reporter` to see additional debugging output.

## TODO

1. `Move to spawn to solve asynchronicity` - Currently, this reporter uses `deasync-promise` to run async code in the synchronous mocha reporter. Most other reporters handle this by executing a separate javascript file outside of the node instance using spawn.