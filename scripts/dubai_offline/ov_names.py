import duckdb,time
t=time.time()
con=duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
con.execute("SET http_timeout=300000;");con.execute("CREATE OR REPLACE SECRET anon (TYPE s3, PROVIDER config, KEY_ID '', SECRET '', REGION 'us-west-2');")
con.execute("""COPY (SELECT id, names.common['en'] AS name_en, names.rules AS rules
FROM read_parquet('s3://overturemaps-us-west-2/release/2026-09-23.1/theme=places/type=place/*', hive_partitioning=1)
WHERE bbox.xmin BETWEEN 54.89 AND 55.56 AND bbox.ymin BETWEEN 24.79 AND 25.36) TO 'dubai_names.parquet' (FORMAT parquet)""")
print("ok",round(time.time()-t))
print(con.execute("select count(*), count(name_en) from 'dubai_names.parquet'").fetchall())
