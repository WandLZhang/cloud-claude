import React, { useState } from 'react';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import vscDarkPlus from 'react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

// The light build ships only these grammars; the full Prism build put every language in the
// main bundle (13.9% of its source). A fence in any other language shows as plain text.
const GRAMMARS = { bash, c, cpp, css, diff, go, java, javascript, json, jsx, markdown, markup, python, sql, tsx, typescript, yaml };
Object.entries(GRAMMARS).forEach(([name, grammar]) => SyntaxHighlighter.registerLanguage(name, grammar));

const ALIASES = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  js: 'javascript', ts: 'typescript', py: 'python',
  html: 'markup', xml: 'markup', svg: 'markup',
  yml: 'yaml', md: 'markdown', 'c++': 'cpp', golang: 'go',
};

// One dark block. The language and a Copy button sit in its top-right corner instead of a header
// row, so a code block takes no more height than its code.
function CodeBlock({ language, text }) {
  const [copied, setCopied] = useState(false);
  const grammar = ALIASES[language] || language;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('[CodeBlock] copy failed:', err);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-tools">
        {language && <span className="code-block-lang">{language}</span>}
        <button type="button" className="code-block-copy" onClick={copy} aria-label={copied ? 'Copied' : 'Copy code'}>
          <span className="icon">{copied ? 'check' : 'content_copy'}</span>
        </button>
      </div>
      <SyntaxHighlighter
        language={GRAMMARS[grammar] ? grammar : 'text'}
        style={vscDarkPlus}
        PreTag="div"
        customStyle={{ margin: 0, padding: '12px 14px', background: 'transparent', fontSize: '0.85em' }}
      >
        {text}
      </SyntaxHighlighter>
    </div>
  );
}

export default CodeBlock;
