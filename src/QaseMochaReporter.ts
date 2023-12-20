'use strict'

import Mocha, { Runnable, Runner, Suite, reporters } from 'mocha'
import { QaseApi } from 'qaseio'
import deasyncPromise from 'deasync-promise'
import { Project, ResultCreate, ResultCreateStatusEnum, Run, RunCreate } from 'qaseio/dist/src/model'
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
    private results: { suiteName?: string, testCaseTitle: string, testCaseResult: TestCaseResult, testCaseDuration?: number }[] = []
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

    private _mochaTestEnd(test: Runnable){
        const testCaseResult = this.resultForTestCase(test)
        console.log(`${this.indent()}${testCaseResult.toUpperCase()} - ${test.fullTitle()}`)

        this.results.push({
            suiteName: this.currentSuiteName,
            testCaseTitle: test.fullTitle(),
            testCaseResult,
            testCaseDuration: test.duration
        })
    }

    private _mochaRunEnd(){
        try {
            deasyncPromise(this.uploadResults())
        } catch(error) {
            throw error
        } finally {
            // Just make sure this always runs
            deasyncPromise(this.endCurrentTestRun())
        }

        if (this.runner.stats !== undefined) {
            console.log(`end: ${this.runner.stats.passes}/${this.runner.stats.passes + this.runner.stats.failures} ok`)
        }
    }

    private resultForTestCase(test: Runnable): 'passed' | 'failed' | 'skipped' {
        if (test.isPassed()) {
            return 'passed'
        } else if(test.isFailed()) {
            return 'failed'
        } else if(test.isPending()) {
            return 'skipped'
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

    private async uploadResults(){
        if (this.qaseTestRunId === undefined) throw new Error(`No qase test run id`)

        const qaseResults: ResultCreate[] = this.results.map(r => {
            return {
                status: r.testCaseResult === 'passed' ? ResultCreateStatusEnum.PASSED : ResultCreateStatusEnum.FAILED,
                case: {
                    suite_title: r.suiteName,
                    title: r.testCaseTitle,
                    time_ms: r.testCaseDuration
                }
            } as ResultCreate
        })

        try {
            debug(`Uploading qase ${qaseResults.length} test results: `)
            debug('CASE RESULT JSON', JSON.stringify(qaseResults, null, '\t'))
            const result = await this.qase.results.createResultBulk(this.qaseProjectCode, this.qaseTestRunId, {
                results: qaseResults
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
        await this.qase.runs.completeRun(this.qaseProjectCode, this.qaseTestRunId)
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