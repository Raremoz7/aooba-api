const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const bars = await prisma.bar.findMany();
  console.log(JSON.stringify(bars, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
