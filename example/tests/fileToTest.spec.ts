import { add } from '../src/fileToTest'
import { expect } from 'chai'

describe('fileToTest', () => {

    it('add works', () => {
        const result = add(1, 2)
        expect(result).to.equal(3)
    })

    it.skip('skip works', () => {
        const result = add(1, 2)
        expect(result).to.equal(3)
    })

    it('failures works', () => {
        const result = add(1, 2)
        expect(result).to.equal(4)
    })

})