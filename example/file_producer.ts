import path = require('path')
import { array, createProducer, file } from '../src'

export default createProducer(async files => {
  return array(async function * () {
    yield file(path.join(__dirname, 'file.ts'), async function * () {
      yield "// Auto Generated, Don't Modify Manually"
      yield '// cotne123'
      yield ''
    })
  })
})

