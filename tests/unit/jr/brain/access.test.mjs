import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canManage, readScope } from '../../../../services/brain/access.mjs';
import { findSecrets, normalize } from '../../../../services/brain/text.mjs';

const GERAL = 1;
const FROTA = 2;
const COMPRAS = 3;
const user = { userId: 'ana', role: 'employee', title: null };

test('owner (diretoria) reads everything', () => {
  assert.deepEqual(readScope({ userId: 'owner', role: 'admin' }, [], GERAL), { all: true });
});

test('other admins are not diretoria', () => {
  const scope = readScope({ userId: 'admin2', role: 'admin' }, [], GERAL);
  assert.equal(scope.all, undefined);
  assert.deepEqual([...scope.low], [GERAL]);
});

test('colaborador reads low of own areas plus Geral, never high', () => {
  const scope = readScope(user, [{ areaId: FROTA, level: 'colaborador', primary: true }], GERAL);
  assert.deepEqual([...scope.low].sort(), [GERAL, FROTA]);
  assert.deepEqual([...scope.high], []);
});

test('gestor of one area and colaborador of another', () => {
  const scope = readScope(
    user,
    [
      { areaId: FROTA, level: 'gestor', primary: true },
      { areaId: COMPRAS, level: 'colaborador', primary: false },
    ],
    GERAL
  );
  assert.deepEqual([...scope.low].sort(), [GERAL, FROTA, COMPRAS]);
  assert.deepEqual([...scope.high], [FROTA]);
});

test('high is never granted for Geral', () => {
  const scope = readScope(user, [{ areaId: GERAL, level: 'gestor', primary: true }], GERAL);
  assert.deepEqual([...scope.high], []);
});

test('canManage: owner or gestor of that area only', () => {
  const memberships = [
    { areaId: FROTA, level: 'gestor', primary: true },
    { areaId: COMPRAS, level: 'colaborador', primary: false },
  ];
  assert.equal(canManage({ userId: 'owner' }, [], FROTA), true);
  assert.equal(canManage(user, memberships, FROTA), true);
  assert.equal(canManage(user, memberships, COMPRAS), false);
  assert.equal(canManage(user, memberships, 99), false);
});

test('normalize lowercases, strips accents and collapses spaces', () => {
  assert.equal(normalize('  Fornecedor   Ação\nÚNICA '), 'fornecedor acao unica');
});

test('findSecrets catches PII and credentials', () => {
  assert.deepEqual(findSecrets('cpf 123.456.789-09'), ['cpf']);
  assert.ok(findSecrets('CNPJ 12.345.678/0001-95').includes('cnpj'));
  assert.deepEqual(findSecrets('cartao 4111 1111 1111 1111'), ['card']);
  assert.deepEqual(findSecrets('fale com joao@empresa.com.br'), ['email']);
  assert.deepEqual(findSecrets('senha: abc123'), ['password']);
  assert.deepEqual(findSecrets('Senha = x'), ['password']);
  assert.ok(findSecrets('chave sk-abcdefghijklmnopqrstuvwx').includes('token'));
  assert.ok(findSecrets('a8f3k29dj4l1m7q0z5x8c3v6b2n9m4k1p').includes('token'));
});

test('findSecrets leaves ordinary work facts alone', () => {
  assert.deepEqual(findSecrets('Fornecedor X passou a cobrar frete de R$ 1.200 em 2026'), []);
  assert.deepEqual(findSecrets('Obra 123 tem 4111 m2 de area e 12 funcionarios'), []);
  assert.deepEqual(findSecrets('internacionalizacaoinstitucionalizacaoconstitucional'), []);
});
