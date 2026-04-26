/**
 * Coverage for parseSource / validateBare / prefixAndSort.
 *
 * Pins the "fail loud on every bare-form violation" contract — each
 * rejection must carry PylonCliError(exitCode=11) so bin.ts can exit
 * with a deterministic code regardless of which specific clause fired.
 */

import { describe, it, expect } from 'vitest';

import { PylonCliError } from '../../errors.js';
import {
  parseSource,
  prefixAndSort,
  validateBare,
  type BareSchema,
} from '../normalize.js';

const validBare: unknown = {
  version_tag: '0.1.0',
  capabilities: [
    { name: 'world.read', description: 'Read worlds' },
    { name: 'world.write' },
  ],
  archetypes: [
    { name: 'user', capabilities: ['world.read'] },
    { name: 'admin', capabilities: ['world.write'], inherits: ['user'] },
  ],
};

function expectExit11(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(PylonCliError);
    expect((err as PylonCliError).exitCode).toBe(11);
    expect((err as PylonCliError).message).toMatch(pattern);
  }
}

describe('parseSource', () => {
  it('parses YAML', () => {
    const yaml = 'version_tag: "0.1.0"\ncapabilities: []\narchetypes: []\n';
    expect(parseSource(yaml, 'inline.yaml')).toEqual({
      version_tag: '0.1.0',
      capabilities: [],
      archetypes: [],
    });
  });

  it('parses JSON via the same entrypoint', () => {
    const json = '{"version_tag":"0.1.0","capabilities":[],"archetypes":[]}';
    expect(parseSource(json, 'inline.json')).toEqual({
      version_tag: '0.1.0',
      capabilities: [],
      archetypes: [],
    });
  });

  it('throws PylonCliError exit 11 on malformed input, naming the path', () => {
    expectExit11(
      () => parseSource('not: yaml: at: all:\n  - [unbalanced', 'bad.yaml'),
      /invalid_source.*bad\.yaml/,
    );
  });
});

describe('validateBare — happy path', () => {
  it('accepts a well-formed bare schema and preserves field shape', () => {
    const out = validateBare(validBare, 'olam');
    expect(out.version_tag).toBe('0.1.0');
    expect(out.capabilities).toHaveLength(2);
    expect(out.archetypes).toHaveLength(2);
    expect(out.capabilities[0]?.description).toBe('Read worlds');
    expect(out.capabilities[1]).not.toHaveProperty('description');
    expect(out.archetypes[1]?.inherits).toEqual(['user']);
  });

  it('omits optional fields when absent rather than coercing to empty', () => {
    const out = validateBare(
      {
        version_tag: '0.1.0',
        capabilities: [{ name: 'cap.a' }],
        archetypes: [{ name: 'role', capabilities: ['cap.a'] }],
      },
      'olam',
    );
    expect(out.archetypes[0]).not.toHaveProperty('inherits');
    expect(out.archetypes[0]).not.toHaveProperty('description');
  });
});

describe('validateBare — name rules', () => {
  it('rejects names containing ":"', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'olam:world.read' }],
            archetypes: [],
          },
          'olam',
        ),
      /must not contain ":"/,
    );
  });

  it('rejects malformed names (uppercase, special chars, leading dash, empty)', () => {
    const cases: Array<[string, RegExp]> = [
      ['World.Read', /must match/],
      ['-bad', /must match/],
      ['has space', /must match/],
      ['', /must match/],
    ];
    for (const [name, pattern] of cases) {
      expectExit11(
        () =>
          validateBare(
            {
              version_tag: '0.1.0',
              capabilities: [{ name }],
              archetypes: [],
            },
            'olam',
          ),
        pattern,
      );
    }
  });

  it('rejects malformed appId (uppercase, contains colon, empty)', () => {
    expectExit11(() => validateBare(validBare, 'BadApp'), /appId.*must match/);
    expectExit11(() => validateBare(validBare, 'olam:nested'), /appId.*must match/);
    expectExit11(() => validateBare(validBare, ''), /appId.*must match/);
  });
});

describe('validateBare — duplicate / cross-ref rules', () => {
  it('rejects duplicate capability names', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'world.read' }, { name: 'world.read' }],
            archetypes: [],
          },
          'olam',
        ),
      /duplicate capability/,
    );
  });

  it('rejects duplicate archetype names', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'world.read' }],
            archetypes: [
              { name: 'user', capabilities: ['world.read'] },
              { name: 'user', capabilities: [] },
            ],
          },
          'olam',
        ),
      /duplicate archetype/,
    );
  });

  it('rejects archetype referencing undeclared capability', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'world.read' }],
            archetypes: [{ name: 'user', capabilities: ['world.write'] }],
          },
          'olam',
        ),
      /undeclared capability/,
    );
  });

  it('rejects dangling inherits reference', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'world.read' }],
            archetypes: [
              { name: 'user', capabilities: ['world.read'], inherits: ['ghost'] },
            ],
          },
          'olam',
        ),
      /inherits unknown archetype/,
    );
  });

  it('rejects 2-cycle in inherits', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'cap' }],
            archetypes: [
              { name: 'a', capabilities: [], inherits: ['b'] },
              { name: 'b', capabilities: [], inherits: ['a'] },
            ],
          },
          'olam',
        ),
      /cycle in archetype inherits/,
    );
  });

  it('rejects 3-cycle in inherits', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'cap' }],
            archetypes: [
              { name: 'a', capabilities: [], inherits: ['b'] },
              { name: 'b', capabilities: [], inherits: ['c'] },
              { name: 'c', capabilities: [], inherits: ['a'] },
            ],
          },
          'olam',
        ),
      /cycle in archetype inherits/,
    );
  });

  it('rejects self-cycle in inherits', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'cap' }],
            archetypes: [{ name: 'a', capabilities: [], inherits: ['a'] }],
          },
          'olam',
        ),
      /cycle in archetype inherits/,
    );
  });
});

describe('validateBare — top-level shape', () => {
  it.each([
    [null, /must be an object/],
    [[], /must be an object/],
    [{}, /version_tag/],
    [{ version_tag: '' }, /version_tag/],
    [{ version_tag: 'v1' }, /capabilities/],
    [{ version_tag: 'v1', capabilities: 'no' }, /capabilities/],
    [{ version_tag: 'v1', capabilities: [] }, /archetypes/],
    [{ version_tag: 'v1', capabilities: [], archetypes: 'no' }, /archetypes/],
  ])('rejects %j', (input, pattern) => {
    expectExit11(() => validateBare(input, 'olam'), pattern);
  });
});

describe('prefixAndSort', () => {
  it('prefixes every name and sorts caps + archetypes + inner arrays', () => {
    const bare: BareSchema = {
      version_tag: '0.1.0',
      capabilities: [
        { name: 'world.write' },
        { name: 'world.read', description: 'Read worlds' },
      ],
      archetypes: [
        {
          name: 'admin',
          capabilities: ['world.write', 'world.read'],
          inherits: ['user'],
        },
        { name: 'user', capabilities: ['world.read'] },
      ],
    };
    const out = prefixAndSort(bare, 'olam');
    expect(out).toEqual({
      version_tag: '0.1.0',
      capabilities: [
        { name: 'olam:world.read', description: 'Read worlds' },
        { name: 'olam:world.write' },
      ],
      archetypes: [
        {
          name: 'olam:admin',
          capabilities: ['olam:world.read', 'olam:world.write'],
          inherits: ['olam:user'],
        },
        { name: 'olam:user', capabilities: ['olam:world.read'] },
      ],
    });
  });

  it('preserves version_tag verbatim', () => {
    const bare: BareSchema = {
      version_tag: 'v1.2.3-beta',
      capabilities: [],
      archetypes: [],
    };
    expect(prefixAndSort(bare, 'olam').version_tag).toBe('v1.2.3-beta');
  });

  it('keeps an empty inherits array (does not collapse to undefined)', () => {
    const bare: BareSchema = {
      version_tag: '0.1.0',
      capabilities: [],
      archetypes: [{ name: 'user', capabilities: [], inherits: [] }],
    };
    const out = prefixAndSort(bare, 'olam');
    expect(out.archetypes[0]?.inherits).toEqual([]);
  });

  it('omits inherits entirely when undefined in input', () => {
    const bare: BareSchema = {
      version_tag: '0.1.0',
      capabilities: [],
      archetypes: [{ name: 'user', capabilities: [] }],
    };
    const out = prefixAndSort(bare, 'olam');
    expect(out.archetypes[0]).not.toHaveProperty('inherits');
  });

  it('omits description when undefined in input', () => {
    const bare: BareSchema = {
      version_tag: '0.1.0',
      capabilities: [{ name: 'cap' }],
      archetypes: [],
    };
    const out = prefixAndSort(bare, 'olam');
    expect(out.capabilities[0]).not.toHaveProperty('description');
  });
});

describe('hardening', () => {
  it('YAML number-coercion of unquoted version_tag is caught with a hint', () => {
    const yaml = 'version_tag: 1.0\ncapabilities: []\narchetypes: []\n';
    expectExit11(
      () => validateBare(parseSource(yaml, 'inline.yaml'), 'olam'),
      /YAML coerced an unquoted version/,
    );
  });

  it('drops __proto__ keys at the capability level (projection defense)', () => {
    const poisoned = JSON.parse(
      '{"version_tag":"0.1.0","capabilities":[{"name":"cap","__proto__":{"polluted":true}}],"archetypes":[]}',
    ) as unknown;
    const out = validateBare(poisoned, 'olam');
    expect(out.capabilities[0]?.name).toBe('cap');
    expect(Object.prototype.hasOwnProperty.call(out.capabilities[0], '__proto__')).toBe(false);
    // Sanity: the global Object prototype was not polluted.
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('cycle detection stays linear: 200-archetype linear chain completes in <100ms', () => {
    const capabilities = [{ name: 'cap' }];
    const archetypes: Array<{ name: string; capabilities: string[]; inherits?: string[] }> = [];
    for (let i = 0; i < 200; i++) {
      archetypes.push({
        name: `arch${i}`,
        capabilities: [],
        ...(i > 0 ? { inherits: [`arch${i - 1}`] } : {}),
      });
    }
    const start = performance.now();
    validateBare({ version_tag: 'v', capabilities, archetypes }, 'olam');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it('error messages quote user input via JSON.stringify (no raw newline injection)', () => {
    expectExit11(
      () =>
        validateBare(
          {
            version_tag: '0.1.0',
            capabilities: [{ name: 'bad\nname' }],
            archetypes: [],
          },
          'olam',
        ),
      // JSON.stringify renders the newline as the literal characters \n,
      // not a real line break. Match for the escaped form.
      /"bad\\nname"/,
    );
  });
});

describe('full pipeline', () => {
  it('YAML → BareSchema → SchemaDeclaration', () => {
    const yaml = `version_tag: "0.2.0"
capabilities:
  - name: world.write
  - name: world.read
    description: Read worlds
archetypes:
  - name: admin
    capabilities: [world.write, world.read]
    inherits: [user]
  - name: user
    capabilities: [world.read]
`;
    const parsed = parseSource(yaml, 'test.yaml');
    const bare = validateBare(parsed, 'olam');
    const out = prefixAndSort(bare, 'olam');
    expect(out).toEqual({
      version_tag: '0.2.0',
      capabilities: [
        { name: 'olam:world.read', description: 'Read worlds' },
        { name: 'olam:world.write' },
      ],
      archetypes: [
        {
          name: 'olam:admin',
          capabilities: ['olam:world.read', 'olam:world.write'],
          inherits: ['olam:user'],
        },
        { name: 'olam:user', capabilities: ['olam:world.read'] },
      ],
    });
  });

  it('determinism: parse + validate + prefix + sort twice → identical output', () => {
    const yaml = `version_tag: "1.0.0"
capabilities:
  - name: a
  - name: b
archetypes:
  - name: r
    capabilities: [b, a]
`;
    const first = prefixAndSort(validateBare(parseSource(yaml, 'inline'), 'app'), 'app');
    const second = prefixAndSort(validateBare(parseSource(yaml, 'inline'), 'app'), 'app');
    expect(first).toEqual(second);
  });
});
