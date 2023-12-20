'use strict'

import Mocha, { Runnable, Runner, Suite, reporters } from 'mocha'
import { QaseApi } from 'qaseio'
import deasyncPromise from 'deasync-promise'
import { Project, ResultCreate, ResultCreateStatusEnum, RunCreate } from 'qaseio/dist/src/model'
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
            deasyncPromise(this.endTestRun())
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

    private async createQaseTestRun(){
        debug('Creating qase test run')
        
        this.qaseTestRunId = await this.createTestRun({
            title: this.qaseTestRunTitle,
            is_autotest: true,
            tags: this.qaseTestRunTags
        })
        if (this.qaseProjectCode == undefined) throw new Error(`Couldn't get qase test run id`)
        
        debug('Created qase test run with id: ', this.qaseTestRunId)
    }

    private async createTestRun(runData: RunCreate): Promise<number | undefined> {
        if (this.qaseProjectCode === undefined) throw new Error(`No qase project`)
        const result = await this.qase.runs.createRun(this.qaseProjectCode, runData)
        return result.data.result?.id
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
            if (error instanceof Error) {
                if ('response' in error) {
                    if ((error.response as any).status === 404) return undefined
                }
            }
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
            debug('Uploading qase test results: ', qaseResults)

            const result = await this.qase.results.createResultBulk(this.qaseProjectCode, this.qaseTestRunId, {
                results: qaseResults
            })
            debug('Uploaded qase test results: ', result.data.status)
        } catch(error) {
            console.error('Error uploading qase test results: ', error)
        }
    }

    private async endTestRun(){
        if (this.qaseProjectCode === undefined) throw new Error(`No qase project`)
        if (this.qaseTestRunId === undefined) throw new Error(`No qase test run id`)
        await this.qase.runs.completeRun(this.qaseProjectCode, this.qaseTestRunId)
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