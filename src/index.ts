import * as Bacon from 'baconjs'
import { Command, flags } from '@oclif/command'
import { blue, green, red, yellow } from 'chalk'
import { promises as fs } from 'fs'
import path = require('path')
import Watchpack = require('watchpack')

const frontendJsDir = root('workspaces/frontend')

function abs (src: string): string {
  return path.resolve(__dirname, src)
}

function root (src: string = ''): string {
  return path.resolve(abs('../../..'), src)
}

function isProducer (src: string): boolean {
  return /_producer\.ts$/.test(src)
}

interface ProducedFile {
  readonly content: string
  readonly path: string
}

type Producer = (files: string[]) => readonly ProducedFile[]

const knownProducers: string[] = []

function requireProducer (src: string): Producer {
  const modulePath = require.resolve(root(path.resolve(frontendJsDir, src)))

  knownProducers.push(modulePath)

  return require(modulePath)
}

async function walk (dirPath: string, base?: string): Promise<string[]> {
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

async function array<T> (iterable: AsyncIterable<T>): Promise<T[]> {
  const arr = []

  for await (const entry of iterable) {
    arr.push(entry)
  }

  return arr
}

async function executeProducersOnFiles (files: string[], check: boolean, watch: boolean): Promise<number> {
  let exitCode = 0

  const producers = files.filter(isProducer)

  for (const producerPath of producers) {
    const producer = requireProducer(producerPath)
    const currentProducedFiles = producer(files)

    if (!watch) console.info(blue(`[PRODUCE] ${path.relative(root(), producerPath)}`))

    for (const file of currentProducedFiles) {
      const filePath = path.relative(root(), file.path)

      let content = ''

      try {
        content = (await fs.readFile(file.path)).toString()
      } catch (err) {}

      if (file.content !== content) {
        if (check) {
          if (watch) console.info(blue(`[PRODUCE] ${path.relative(root(), producerPath)}`))
          console.info(red(`  [ERROR] ${filePath}`))
          exitCode = 1
        } else {
          if (watch) console.info(blue(`[PRODUCE] ${path.relative(root(), producerPath)}`))
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

async function executeProducers (check: boolean, watch: boolean): Promise<number | void> {
  if (!watch) {
    return await executeProducersOnFiles((await walk(frontendJsDir)), check, watch)
  }

  await executeProducersOnFiles((await walk(frontendJsDir)), check, watch)

  const changes = Bacon.fromBinder<{readonly path: string, readonly time: number | null, readonly event: string}>(sink => {
    const wp = new Watchpack({})

    wp.watch([], [frontendJsDir])
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

          return void executeProducersOnFiles(await walk(frontendJsDir), check, watch)
        }
      }
    })
}

class ProducersCliCommand extends Command {
  static description = ''

  static flags = {
    help: flags.help(),
    check: flags.boolean({ default: false, description: 'Just check files' }),
    watch: flags.boolean({ default: false, description: 'Watch for changes' })
  }

  async run (): Promise<void> {
    const { flags: { check, watch } } = this.parse(ProducersCliCommand)

    const exitCode = await executeProducers(check, watch)

    if (typeof exitCode === 'number') this.exit(exitCode)
  }
}

export = ProducersCliCommand
