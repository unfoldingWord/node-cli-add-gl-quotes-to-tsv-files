# node-cli-add-gl-quotes-to-tsv-files

CLI tool to add GL quotes to TSV files in a directory. Processes TSV files by adding Gateway Language quotes and occurrence columns, then packages the modified files into a zip archive.

## Install

```bash
npm install --global add-gl-quotes-to-tsv-files
```

## Usage

```bash
add-gl-quotes-to-tsv-files [options]
```

### Options

```
--workingdir, -w   Directory where the TSV files are located (default: current directory)
--owner            Repository owner
--repo             Repository name
--ref              Git reference (branch/tag)
--dcs              DCS URL
--output, -o       Output zip file's path
--quiet, -q        Suppress all output (default: false)
```

### Parameter Resolution Priority

1. Command line arguments
2. GitHub Actions environment variables
3. Git repository information



### Output

#### Zip Filename

If no output filename is specified for the zip file, it will be generated as: 

`<repo>_<ref>_with_gl_quotes.zip`

in the working directory

#### Zip File's Contents

The generated zip file will contain:
- Modified TSV files with added GL Quote and GL Occurrence columns
- README.md (if present)
- LICENSE.md (if present)
- manifest.yaml

## Development

1. Clone this repository
```bash
git clone https://github.com/your-username/node-cli-add-gl-quotes-to-tsv-files.git
cd node-cli-add-gl-quotes-to-tsv-files
```

2. Install dependencies
```bash
npm install
```

3. Link the package
```bash
npm link
```

Now you can run `add-gl-quotes-to-tsv-files` from anywhere to test your changes.

## License

MIT
