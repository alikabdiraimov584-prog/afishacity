import duckdb,sys,time
t=time.time()
con=duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
con.execute("SET http_timeout=300000;");con.execute("CREATE OR REPLACE SECRET anon (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2');")
q="""
COPY (SELECT id, names.primary AS name, taxonomy.primary AS cat, taxonomy.hierarchy AS cat_path, taxonomy.alternates AS cats_alt, basic_category,
  confidence, websites, phones, socials, emails, brand.names.primary AS brand, brand.wikidata AS brand_wikidata, addresses,
  (bbox.ymin+bbox.ymax)/2 AS lat, (bbox.xmin+bbox.xmax)/2 AS lon, operating_status
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/*', hive_partitioning=1)
WHERE bbox.xmin BETWEEN 54.89 AND 55.56 AND bbox.ymin BETWEEN 24.79 AND 25.36)
TO 'dubai_overture.parquet' (FORMAT parquet);
"""

con.execute(q)
print("скачано за",round(time.time()-t),"с")
print(con.execute("SELECT count(*), count(*) FILTER (WHERE confidence>=0.6), avg(len(phones)>0)::DECIMAL(4,2), avg(len(websites)>0)::DECIMAL(4,2), avg(len(socials)>0)::DECIMAL(4,2), avg(len(addresses)>0)::DECIMAL(4,2) FROM 'dubai_overture.parquet'").fetchall())
print(con.execute("SELECT basic_category, count(*) n FROM 'dubai_overture.parquet' WHERE confidence>=0.5 GROUP BY 1 ORDER BY n DESC LIMIT 80").fetchall())
