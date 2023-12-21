'use strict'

import Mocha, { Runnable, Runner, Suite, Test, reporters } from 'mocha'
import { QaseApi } from 'qaseio'
import deasyncPromise from 'deasync-promise'
import { Project, ResultCreate, ResultCreateCase, ResultCreateStatusEnum, Run, RunCreate } from 'qaseio/dist/src/model'
import createDebug from 'debug'

const debug = createDebug('qase-mocha-reporter')

const {
  EVENT_RUN_BEGIN,
  EVENT_RUN_END,
  EVENT_SUITE_BEGIN,
  EVENT_SUITE_END,
  EVENT_TEST_END
} = Mocha.Runner.constants

type TestCaseResult = 'passed' | 'failed' | 'skipped'

type QaseApiResponse = {
    status: number
    statusText: string
    data?: Record<string, unknown>
}

function _requireEnvVar(name: string): string {
    const value = process.env[name]
    if (value === undefined) throw new Error(`qase-mocha-report requires you to set an env var named '${name}'.`)
    return value
}

function _qaseTestRunTagsFromEnvVar(name: string): string[] | undefined {
    const tagsString = process.env[name]
    if (tagsString === undefined) return undefined
    return tagsString.split(',').map(t => t.trim() )
}

export class QaseMochaReporter extends reporters.Base {

    private qase = new QaseApi(_requireEnvVar('QASE_API_TOKEN') )
    private qaseProjectCode = _requireEnvVar('QASE_PROJECT_CODE') 
    private qaseTestRunTitle = _requireEnvVar('QASE_TEST_RUN_TITLE') 
    private qaseTestRunTags = _qaseTestRunTagsFromEnvVar('QASE_TEST_RUN_TAGS')

    private qaseTestRunId: number | undefined
    private currentSuiteName: string | undefined
    private results: { suiteName?: string, testCaseTitle: string, testCaseResult: TestCaseResult, testCaseDuration?: number, stacktrace?: string }[] = []
    private _indents = 0

    runner: Runner

    constructor(runner: Runner) {
        super(runner)
        this.runner = runner
        runner.once(EVENT_RUN_BEGIN, this._mochaBegin.bind(this))
        runner.on(EVENT_SUITE_BEGIN, this._mochaSuiteBegin.bind(this))
        runner.on(EVENT_SUITE_END, this._mochaSuiteEnd.bind(this))
        runner.on(EVENT_TEST_END, this._mochaTestEnd.bind(this))
        runner.once(EVENT_RUN_END, this._mochaRunEnd.bind(this))
    }

    private _mochaBegin(){
        deasyncPromise(this.ensureQaseProjectExists())
        deasyncPromise(this.createQaseTestRun())
    }

    private _mochaSuiteBegin(suite: Suite){
        this.increaseIndent()
        this.currentSuiteName = suite.title
    }

    private _mochaSuiteEnd(_suite: Suite){
        this.decreaseIndent()
        this.currentSuiteName = undefined
    }

    private _mochaTestEnd(test: Test){
        const testCaseResult = this.resultForTestCase(test)
        console.log(`${this.indent()}${testCaseResult.toUpperCase()} - ${test.fullTitle()}`)

        let error: Record<string, unknown> | undefined = undefined
        if (test.err !== undefined) {
            error = this._cleanCycles(this._errorJSON(test.err))
        }
        
        this.results.push({
            suiteName: this.currentSuiteName,
            testCaseTitle: test.fullTitle(),
            testCaseResult,
            testCaseDuration: test.duration,
            stacktrace: test.err !== undefined ? test.err.stack : undefined
        })
    }

    private _errorJSON(err: Error): Record<string, unknown> {
        const res: Record<string, unknown> = { }
        Object.getOwnPropertyNames(err).forEach(function (key) {
          res[key] = (err as any)[key]
        }, err)
        return res
    }

    /**
     * Taken from the mocha json reporter
     * @param obj 
     * @returns 
     */
    private _cleanCycles(obj: Record<string, unknown>): Record<string, unknown> {
        const cache: unknown[] = []

        return JSON.parse(
          JSON.stringify(obj, function (_key, value) {
            if (typeof value === 'object' && value !== null) {
              if (cache.indexOf(value) !== -1) {
                // Instead of going in a circle, we'll print [object Object]
                return '' + value;
              }
              cache.push(value);
            }
            return value;
          })
        )
      }

    private _mochaRunEnd(){
        try {
            deasyncPromise(this.uploadResults())
        } catch(error) {
            console.error(`Error uploading results`, error)
        }

        deasyncPromise(this.endCurrentTestRun())

        if (this.runner.stats !== undefined) {
            console.log(`end: ${this.runner.stats.passes}/${this.runner.stats.passes + this.runner.stats.failures} ok`)
        }
    }

    private resultForTestCase(test: Runnable): 'passed' | 'failed' | 'skipped' {
        console.log('GETTING RESULT', test.isFailed(), test.isPassed(), test.isPending(), test.pending)
        if (test.isPending()) return 'skipped'

        if (test.isPassed()) {
            return 'passed'
        } else if(test.isFailed()) {
            return 'failed'
        } 
        throw new Error('Unknown test case result')
    }

    private async createQaseTestRun(autoCompleteActiveTestRuns = true){
        const runData: RunCreate = {
            title: this.qaseTestRunTitle,
            is_autotest: true,
            tags: this.qaseTestRunTags
        }
        
        const result = await this.createTestRun(runData)
        if ('testRunNumber' in result) {
            this.qaseTestRunId = result.testRunNumber
        } else if('error' in result && result.error === 'active-run-limit-reached' && autoCompleteActiveTestRuns) {
            await this.completeActiveRuns()

            // retry
            const result = await this.createTestRun(runData)
            if ('testRunNumber' in result) {
                this.qaseTestRunId = result.testRunNumber
            }
        }

        if (this.qaseTestRunId === undefined) {
            const message = `Couldn't create a qase test run in the '${this.qaseProjectCode}' project.`
            console.error(message)
            throw new Error(message)
        }

        console.log('Created qase test run with id: ', this.qaseTestRunId)
    }

    private async completeActiveRuns(){
        const activeRuns = await this.getRecentActiveTestRuns()
        if (activeRuns.length === 0) return

        for (const run of activeRuns) {
            await this.completeTestRun(run)
        }
    }

    private async getRecentActiveTestRuns(limit = 10){
        try {
            const result = await this.qase.runs.getRuns(this.qaseProjectCode, undefined, limit, 0)
            const runs = result.data.result
            if (runs === undefined || runs.total === 0 || runs.entities === undefined) return []
            const activeRuns = runs.entities.filter(run => {
                return run.status_text === 'active'
            })
            debug('Fetched active qase runs: ', activeRuns)
            return activeRuns
        } catch(error) {
            const message = `Couldn't get active test runs for the '${this.qaseProjectCode}' project.`
            console.error(message, error)
            throw new Error(message)
        }
    }

    private async createTestRun(runData: RunCreate): Promise<{ testRunNumber: number } | { error: 'active-run-limit-reached' }> {
        try {
            const result = await this.qase.runs.createRun(this.qaseProjectCode, runData)
            if (result.data.result?.id === undefined) throw new Error(`Couldn't create a qase test run`)

            return {
                testRunNumber: result.data.result.id
            }
        } catch(error) {
            if (this.isLimitOfActiveRunsError(error)) {
                return {
                    error: 'active-run-limit-reached'
                }
            }
            throw error
        }
    }

    private isLimitOfActiveRunsError(error: unknown){
        const response = this.extractErrorResponse(error)
        if (response === undefined) return false
        if (response.status !== 403) return false

        const errorMessage = response.data?.errorMessage as string | undefined
        if (errorMessage === undefined) return false

        return errorMessage.toLowerCase().includes('limit of active runs')
    }

    private extractErrorResponse(error: unknown): QaseApiResponse | undefined {
        if (error instanceof Error) {
            if ('response' in error) {
                const response = error.response as QaseApiResponse
                return {
                    status: response.status,
                    statusText: response.statusText,
                    data: response.data
                }
            }
        }
        throw error
    }

    private async ensureQaseProjectExists(){
        const project = await this.getProject(this.qaseProjectCode)
        if (project === undefined) {
            console.error(`You must first create a Qase project in their UI with a project code of: '${this.qaseProjectCode}'`)
            throw new Error(`You must first create a Qase project in their UI with a project code of: '${this.qaseProjectCode}'`)
        }
    }

    private async getProject(name: string): Promise<Project | undefined> {
        try {
            const result = await this.qase.projects.getProject(name)
            return result.data.result
        } catch(error) {
            const response = this.extractErrorResponse(error)
            if (response?.status === 404) return undefined // project does not exist
            throw error
        }
    }

    private qaseStatusForTestCaseResult(result: TestCaseResult): ResultCreateStatusEnum {
        if (result === 'skipped') return ResultCreateStatusEnum.SKIPPED
        if (result === 'passed') return ResultCreateStatusEnum.PASSED
        if (result === 'failed') return ResultCreateStatusEnum.FAILED
        return ResultCreateStatusEnum.INVALID
    }

    private async uploadResults(){
        if (this.qaseTestRunId === undefined) throw new Error(`No qase test run id`)

        const qaseResults: ResultCreate[] = this.results.map(r => {
            const qaseCase: ResultCreateCase = {
                suite_title: r.suiteName,
                title: r.testCaseTitle
            }

            return {
                status: this.qaseStatusForTestCaseResult(r.testCaseResult),
                case: qaseCase,
                time_ms: r.testCaseDuration,
                stacktrace: r.stacktrace
            } as ResultCreate
        })

        try {
            debug(`Uploading qase ${qaseResults.length} test results for run id=${this.qaseTestRunId}: `)
            // debug('CASE RESULT JSON', JSON.stringify(qaseResults, null, '\t'))
            const result = await this.qase.results.createResultBulk(this.qaseProjectCode, this.qaseTestRunId, {
                results: qaseResults
            }, {
                timeout: 15000
            })
            debug(`Uploaded ${qaseResults.length} qase test results: `, result.data.status)
        } catch(error) {
            const response = this.extractErrorResponse(error)
            const message = `Error uploading qase test results: status=${response?.status}; data=${JSON.stringify(response?.data)}`
            console.error(message)
            throw new Error(message)
        }
    }

    private async endCurrentTestRun(){
        if (this.qaseTestRunId === undefined) throw new Error(`No qase test run id`)
        debug(`Completing qase test run id=${this.qaseTestRunId}`)
        await this.qase.runs.completeRun(this.qaseProjectCode, this.qaseTestRunId)
        debug(`Completed qase test run id=${this.qaseTestRunId}`)
    }

    private async completeTestRun(run: Run){
        if (run.id === undefined) throw new Error(`No qase test run id`)
        await this.qase.runs.completeRun(this.qaseProjectCode, run.id)
    }

    private indent() {
        return Array(this._indents).join('  ')
    }

    private increaseIndent() {
        this._indents++
    }

    private decreaseIndent() {
        this._indents--
    }
}