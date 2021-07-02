import * as Bacon from 'baconjs'
import { Command, flags } from '@oclif/command'
import { blue, green, red, yellow } from 'chalk'
import { promises as fs } from 'fs'
import path = require('path')
import Watchpack = require('watchpack')

export function isProducer (src: string): boolean {
  return /_producer\.ts$/.test(src)
}

export function createProducer(fn: Producer): Producer {
  return fn
}

export type UniversalIterable<T> =
  | AsyncIterable<T>
  | (() => AsyncIterable<T>)
  | Iterable<T>
  | (() => Iterable<T>)

export function makeAsyncIterable<T>(value: UniversalIterable<T>): AsyncIterable<T>  {
  const iterable = typeof value === 'function' ? value() : value

  return (async function* () {
    for await (const value of iterable) {
      yield value
    }
  })()
}

export async function array<T> (iterable: UniversalIterable<T>): Promise<readonly T[]> {
  const arr = []

  for await (const entry of makeAsyncIterable(iterable)) {
    arr.push(entry)
  }

  return arr
}

export async function file (path: string, iterable: UniversalIterable<string>): Promise<ProducedFile> {
  return {
    path,
    content: (await array(makeAsyncIterable(iterable))).join('\n')
  }
}
export interface ProducedFile {
  readonly content: string
  readonly path: string
}

export type Producer = (files: readonly string[]) => Promise<readonly ProducedFile[]>

const knownProducers: string[] = []

function requireProducer (src: string): Producer {
  const modulePath = require.resolve(src)

  knownProducers.push(modulePath)

  return require(modulePath).default
}

async function walk (dirPath: string, base?: string): Promise<readonly string[]> {
  return await array(scandir(dirPath, base))
}

async function * scandir (dirPath: string, base?: string): AsyncIterable<string> {
  const basePath = base ?? dirPath

  for (const file of await fs.readdir(dirPath)) {
    const filePath = `${dirPath}/${file}`

    if ((await fs.stat(filePath)).isDirectory()) {
      yield * scandir(filePath, basePath)
    } else {
      yield path.relative(basePath, filePath)
    }
  }
}

async function executeProducersOnFiles (dir: string, check: boolean, watch: boolean): Promise<number> {
  const files: readonly string[] = await walk(dir)

  let exitCode = 0

  const producers = files.filter(isProducer)

  for (const producerPath of producers) {
    const producer = requireProducer(path.resolve(dir, producerPath))

    const currentProducedFiles = producer(files)

    if (!watch) console.info(blue(`[PRODUCE] ${producerPath}`))

    for (const file of await currentProducedFiles) {
      const filePath = path.relative(dir, file.path)

      let content = ''

      try {
        content = (await fs.readFile(file.path)).toString()
      } catch (err) {}

      if (file.content !== content) {
        if (check) {
          if (watch) console.info(blue(`[PRODUCE] ${producerPath}`))
          console.info(red(`  [ERROR] ${filePath}`))
          exitCode = 1
        } else {
          if (watch) console.info(blue(`[PRODUCE] ${producerPath}`))
          console.info(yellow(`  [FIXED] ${filePath}`))
          await fs.writeFile(file.path, file.content)
        }
      } else {
        if (!watch) console.info(green(`   [OKEY] ${filePath}`))
      }
    }
  }

  return exitCode
}

async function executeProducers (dir: string, check: boolean, watch: boolean): Promise<number | void> {
  const status = await executeProducersOnFiles(dir, check, watch)

  if (!watch) return status

  const changes = Bacon.fromBinder<{readonly path: string, readonly time: number | null, readonly event: string}>(sink => {
    const wp = new Watchpack({})

    wp.watch([], [dir])
    wp.on('change', (path: string, time: number, event: string) => void sink({ path, time, event }))

    return () => void wp.close()
  })

  changes
    .bufferWithTime(500)
    .onValue(async (values): Promise<void> => {
      for (let i = 0; i < values.length; i++) {
        const value = values[i]!

        if (value.event !== 'change' || isProducer(value.path)) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          knownProducers.forEach(producer => void delete require.cache[producer])

          return void executeProducersOnFiles(dir, check, watch)
        }
      }
    })
}

export default class ProducersCliCommand extends Command {
  static description = 'Create Files Programmatically'
  static args = [
    {
      name: 'DIR',
      required: true,
    }
  ]
  static flags = {
    help: flags.help(),
    check: flags.boolean({ default: false, description: 'Just check files' }),
    watch: flags.boolean({ default: false, description: 'Watch for changes' })
  }

  async run (): Promise<void> {
    const options = this.parse(ProducersCliCommand)

    const exitCode = await executeProducers(
      path.resolve(process.cwd(), options.args.DIR),
      options.flags.check,
      options.flags.watch
    )

    if (typeof exitCode === 'number') this.exit(exitCode)
  }
}
