import { describe, it, expect, vi } from 'vitest';

vi.mock('../firebaseConfig', () => {
  const orders = [
    {
      deliveryDate: '2024-01-05',
      articles: [
        { id: 'A1', received: 5 },
        { id: 'B1', received: 3 }
      ]
    },
    {
      deliveryDate: '2024-01-20',
      articles: [
        { id: 'A1', received: 2 }
      ]
    },
    {
      deliveryDate: '2024-02-01',
      articles: [
        { id: 'A1', received: 10 }
      ]
    }
  ];

  const mockGetDocs = async (q) => {
    const clauses = q.clauses || [];
    let filtered = orders;
    clauses.forEach(({ field, op, value }) => {
      if (field === 'deliveryDate') {
        if (op === '>=') filtered = filtered.filter(o => o.deliveryDate >= value);
        if (op === '<=') filtered = filtered.filter(o => o.deliveryDate <= value);
      }
    });
    return {
      forEach: (cb) => filtered.forEach((order, idx) => cb({ data: () => order, id: `id${idx}` }))
    };
  };

  return {
    db: {},
    collection: (...args) => ({ path: args.join('/') }),
    where: (field, op, value) => ({ field, op, value }),
    query: (col, ...clauses) => ({ col, clauses }),
    getDocs: mockGetDocs
  };
});

vi.mock('../utils/hotelUtils', () => ({
  getSelectedHotelUid: () => 'hotel1'
}));

import { getOrderedUnitsByArticle } from './ordersAdapter';

describe('getOrderedUnitsByArticle', () => {
  it('aggregates received quantities using deliveryDate', async () => {
    const result = await getOrderedUnitsByArticle({
      articleIds: ['A1', 'B1'],
      start: '2024-01-01',
      end: '2024-01-31'
    });
    expect(result).toEqual({ A1: 7, B1: 3 });
  });
});
